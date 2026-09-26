/**
 * Lifetime Value Autopilot — /dashboard/ltv-autopilot
 *
 * Scores every customer's real paid LTV + 90-day trend, segments them,
 * and points each segment at a specific existing Automation Marketplace
 * template — never a new send channel. See src/lib/ltvAutopilot.ts for
 * the segment -> template mapping and the disclosed thresholds.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowRight, CheckCircle2, ChevronDown, Rocket, TrendingDown, TrendingUp, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { AUTOMATION_TEMPLATES } from '@/lib/automationMarketplace';
import {
  computeSummary,
  fetchActiveTemplateSlugs,
  fetchProfiles,
  formatCents,
  relativeTime,
  runRecompute,
  setActionStatus,
  SEGMENT_COLORS,
  SEGMENT_LABELS,
  SEGMENT_RECOMMENDED_ACTION,
  SEGMENT_TEMPLATE_SLUG,
  type LtvProfile,
  type LtvSegment,
} from '@/lib/ltvAutopilot';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary transition-colors';

const ACTIONABLE_SEGMENTS: LtvSegment[] = ['vip_at_risk', 'vip_growing', 'reactivation_candidate', 'new_customer'];
const ALL_SEGMENTS = Object.keys(SEGMENT_LABELS) as LtvSegment[];

export function LtvAutopilotPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [profiles, setProfiles] = useState<LtvProfile[]>([]);
  const [activeSlugs, setActiveSlugs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [recomputing, setRecomputing] = useState(false);
  const [segmentFilter, setSegmentFilter] = useState<LtvSegment | 'all'>('all');
  const [pendingOnly, setPendingOnly] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, slugs] = await Promise.all([fetchProfiles(), fetchActiveTemplateSlugs()]);
      setProfiles(p);
      setActiveSlugs(slugs);
    } catch {
      toast('Could not load LTV profiles.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  const handleRecompute = async () => {
    setRecomputing(true);
    try {
      const count = await runRecompute();
      toast(`Recomputed LTV for ${count} customer${count === 1 ? '' : 's'}.`, 'success');
      await load();
    } catch {
      toast('Recompute failed. Try again in a moment.', 'error');
    } finally {
      setRecomputing(false);
    }
  };

  const handleStatus = async (profile: LtvProfile, status: 'actioned' | 'dismissed') => {
    if (!user) return;
    setSavingId(profile.id);
    try {
      await setActionStatus(profile.id, status, undefined, user.id);
      toast(status === 'actioned' ? 'Marked as actioned.' : 'Dismissed.', 'success');
      await load();
    } catch {
      toast('Could not save.', 'error');
    } finally {
      setSavingId(null);
    }
  };

  const summary = useMemo(() => computeSummary(profiles), [profiles]);

  const filtered = useMemo(
    () =>
      profiles.filter((p) => {
        if (segmentFilter !== 'all' && p.segment !== segmentFilter) return false;
        if (pendingOnly && p.action_status !== 'pending') return false;
        return true;
      }),
    [profiles, segmentFilter, pendingOnly],
  );

  const templateName = (slug: string | null) => AUTOMATION_TEMPLATES.find((t) => t.slug === slug)?.name ?? slug;

  return (
    <DashboardLayout activeLabel="LTV Autopilot">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Rocket size={20} />
            </span>
            <div>
              <h1 className="text-2xl font-bold text-text-primary">Lifetime Value Autopilot</h1>
              <p className="mt-1 text-sm text-text-secondary">
                Every customer, scored and segmented — with the exact automation to turn on for each.
              </p>
            </div>
          </div>
          <button
            onClick={handleRecompute}
            disabled={recomputing}
            className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-bg-tertiary disabled:opacity-60"
          >
            <Rocket size={14} className={recomputing ? 'animate-pulse' : ''} />
            Recompute LTV
          </button>
        </div>

        {loading ? (
          <div className="space-y-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : profiles.length === 0 ? (
          <div className="flex items-start gap-3 rounded-2xl border border-dashed border-border p-6 text-sm text-text-secondary">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <p>No LTV profiles yet. Click "Recompute LTV" above to score every customer from their paid job history.</p>
          </div>
        ) : (
          <>
            {/* Header stats */}
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">{summary.totalCustomers}</p>
                <p className="text-xs text-text-secondary">Customers scored</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-success-500">{formatCents(summary.totalLifetimeCents)}</p>
                <p className="text-xs text-text-secondary">Total lifetime value</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-accent">{formatCents(summary.totalPredictedAnnualCents)}</p>
                <p className="text-xs text-text-secondary">Predicted next 12mo</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-warning-500">{summary.pendingCount}</p>
                <p className="text-xs text-text-secondary">Awaiting action</p>
              </div>
            </div>

            {/* Segment breakdown / playbook */}
            <div className="mb-6 overflow-hidden rounded-2xl border border-border bg-bg-secondary">
              <div className="border-b border-border px-4 py-3">
                <p className="text-sm font-semibold text-text-primary">Segments &amp; the automation to run</p>
              </div>
              <div className="divide-y divide-border">
                {ALL_SEGMENTS.filter((s) => summary.bySegment[s] > 0).map((segment) => {
                  const slug = SEGMENT_TEMPLATE_SLUG[segment];
                  const isOn = slug ? activeSlugs.has(slug) : null;
                  return (
                    <button
                      key={segment}
                      onClick={() => setSegmentFilter(segmentFilter === segment ? 'all' : segment)}
                      className={`block w-full px-4 py-3 text-left transition-colors hover:bg-bg-tertiary/50 ${
                        segmentFilter === segment ? 'bg-bg-tertiary/60' : ''
                      }`}
                    >
                      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${SEGMENT_COLORS[segment]}`}>
                          {SEGMENT_LABELS[segment]}
                        </span>
                        <span className="text-xs text-text-secondary">{summary.bySegment[segment]} customer{summary.bySegment[segment] === 1 ? '' : 's'}</span>
                      </div>
                      <p className="text-xs text-text-secondary">{SEGMENT_RECOMMENDED_ACTION[segment]}</p>
                      {slug && (
                        <div className="mt-1.5 flex items-center gap-1.5 text-xs">
                          {isOn ? (
                            <span className="inline-flex items-center gap-1 text-success-500"><CheckCircle2 size={12} /> {templateName(slug)} is already on</span>
                          ) : (
                            <Link to="/dashboard/automation-marketplace" className="inline-flex items-center gap-1 font-semibold text-accent hover:underline">
                              Turn on "{templateName(slug)}" <ArrowRight size={12} />
                            </Link>
                          )}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Filters */}
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
              <select
                value={segmentFilter}
                onChange={(e) => setSegmentFilter(e.target.value as LtvSegment | 'all')}
                className={`${inputClass} sm:w-64`}
              >
                <option value="all">All segments</option>
                {ALL_SEGMENTS.map((s) => (
                  <option key={s} value={s}>{SEGMENT_LABELS[s]}</option>
                ))}
              </select>
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <input type="checkbox" checked={pendingOnly} onChange={(e) => setPendingOnly(e.target.checked)} />
                Pending action only
              </label>
            </div>

            {/* Customer list */}
            <div className="overflow-hidden rounded-2xl border border-border bg-bg-secondary">
              {filtered.length === 0 ? (
                <p className="p-6 text-center text-sm text-text-secondary">No customers match this filter.</p>
              ) : (
                <div className="divide-y divide-border">
                  {filtered.map((p) => {
                    const isOpen = expandedId === p.id;
                    const trendUp = p.trend === 'rising';
                    const trendDown = p.trend === 'declining';
                    const showActions = ACTIONABLE_SEGMENTS.includes(p.segment) && p.action_status === 'pending';
                    return (
                      <div key={p.id}>
                        <button
                          onClick={() => setExpandedId(isOpen ? null : p.id)}
                          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-tertiary/50"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-text-primary">{p.customer_name}</p>
                            <p className="text-xs text-text-secondary">
                              {relativeTime(p.days_since_last_job)} &middot; {p.completed_job_count} job{p.completed_job_count === 1 ? '' : 's'}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-3">
                            {trendUp && <TrendingUp size={14} className="text-success-500" />}
                            {trendDown && <TrendingDown size={14} className="text-danger" />}
                            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${SEGMENT_COLORS[p.segment]}`}>
                              {SEGMENT_LABELS[p.segment]}
                            </span>
                            <span className="text-sm font-semibold text-text-primary">{formatCents(p.lifetime_value_cents)}</span>
                            <ChevronDown size={16} className={`text-text-secondary transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                          </div>
                        </button>

                        {isOpen && (
                          <div className="space-y-3 border-t border-border bg-bg-primary/40 px-4 py-4 text-sm">
                            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                              <div>
                                <p className="text-xs text-text-secondary">Trailing 90 days</p>
                                <p className="font-semibold text-text-primary">{formatCents(p.trailing_90d_cents)}</p>
                              </div>
                              <div>
                                <p className="text-xs text-text-secondary">Prior 90 days</p>
                                <p className="font-semibold text-text-primary">{formatCents(p.prior_90d_cents)}</p>
                              </div>
                              <div>
                                <p className="text-xs text-text-secondary">Predicted next 12mo</p>
                                <p className="font-semibold text-accent">{formatCents(p.predicted_annual_value_cents)}</p>
                              </div>
                            </div>

                            <p className="text-text-secondary">{SEGMENT_RECOMMENDED_ACTION[p.segment]}</p>

                            {p.action_status !== 'pending' && (
                              <p className="text-xs text-text-secondary">
                                Marked <span className="font-semibold text-text-primary">{p.action_status}</span>
                                {p.actioned_at ? ` on ${new Date(p.actioned_at).toLocaleDateString()}` : ''}.
                              </p>
                            )}

                            {showActions && (
                              <div className="flex gap-2">
                                <button
                                  onClick={() => handleStatus(p, 'actioned')}
                                  disabled={savingId === p.id}
                                  className="focus-ring inline-flex items-center gap-1.5 rounded-xl bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-60"
                                >
                                  <CheckCircle2 size={13} /> Mark actioned
                                </button>
                                <button
                                  onClick={() => handleStatus(p, 'dismissed')}
                                  disabled={savingId === p.id}
                                  className="focus-ring inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:bg-bg-tertiary disabled:opacity-60"
                                >
                                  <X size={13} /> Dismiss
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
