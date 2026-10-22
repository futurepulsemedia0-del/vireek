/**
 * HR & Onboarding — /dashboard/hr
 *
 * Owner-only employee onboarding and HR basics: checklist templates, dated onboarding tasks, document
 * collection, 30/60/90-day review reminders and simple performance reviews. Every table is owner-only under RLS
 * (supabase/migrations/20271021000000_hr_onboarding.sql); pure rules live in lib/hrOnboarding.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, ClipboardList, Lock, UserPlus } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { DocumentsPanel } from '@/components/hr/DocumentsPanel';
import { StatTile, type HrCtx } from '@/components/hr/HrUi';
import { OnboardingPanel } from '@/components/hr/OnboardingPanel';
import { ReviewsPanel } from '@/components/hr/ReviewsPanel';
import { TemplatesPanel } from '@/components/hr/TemplatesPanel';
import { useAuth } from '@/contexts/AuthContext';
import { localIsoDate, summarizeHr } from '@/lib/hrOnboarding';
import { fetchHrData, notifyDueReviews, type HrData } from '@/lib/hrOnboardingApi';

const TABS = [
  { id: 'onboarding', label: 'Onboarding' },
  { id: 'documents', label: 'Documents' },
  { id: 'reviews', label: 'Reviews' },
  { id: 'templates', label: 'Templates' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const isTab = (v: string | null): v is TabId => TABS.some((t) => t.id === v);

export function HrOnboardingPage() {
  const { profile, isOwner } = useAuth();
  const [params, setParams] = useSearchParams();
  const ownerId = isOwner ? (profile?.id ?? null) : null;
  const today = useMemo(() => localIsoDate(), []);
  const tabParam = params.get('tab');
  const tab: TabId = isTab(tabParam) ? tabParam : 'onboarding';

  const [data, setData] = useState<HrData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [startSignal, setStartSignal] = useState(0);
  const loadSeq = useRef(0);
  const notified = useRef(false);

  const load = useCallback(async () => {
    if (!ownerId) return;
    const mine = ++loadSeq.current;
    try {
      const next = await fetchHrData(ownerId);
      if (mine !== loadSeq.current) return;
      setData(next);
      setLoadError(false);
      if (!notified.current) {
        notified.current = true;
        void notifyDueReviews();
      }
    } catch {
      if (mine !== loadSeq.current) return;
      setLoadError(true);
    }
  }, [ownerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useCallback((fn: (d: HrData) => HrData) => setData((d) => (d ? fn(d) : d)), []);
  const reload = useCallback(() => load(), [load]);
  const setTab = (id: TabId) => setParams(id === 'onboarding' ? {} : { tab: id }, { replace: true });

  const summary = useMemo(() => (data ? summarizeHr(data, today) : null), [data, today]);

  if (!isOwner) {
    return (
      <DashboardLayout activeLabel="HR & Onboarding">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} aria-hidden="true" />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">HR is available to the account owner only</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Onboarding records, employee documents and performance reviews are sensitive, so they are restricted to the owner of this account.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  const ctx: HrCtx | null = data && ownerId ? { ownerId, today, data, patch, reload } : null;
  const counts: Record<TabId, number> = {
    onboarding: summary?.activeOnboardings ?? 0,
    documents: summary?.openDocuments ?? 0,
    reviews: summary?.reviewsDue ?? 0,
    templates: data?.templates.length ?? 0,
  };

  return (
    <DashboardLayout activeLabel="HR & Onboarding">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <ClipboardList size={22} className="text-accent" aria-hidden="true" /> HR &amp; Onboarding
            </h1>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-text-secondary">
              Onboard new hires with dated checklists, collect their documents, and never miss a 30, 60 or 90-day review. Visible to the account owner only.
            </p>
          </div>
          <Button
            size="sm"
            disabled={!ctx}
            onClick={() => {
              setTab('onboarding');
              setStartSignal((n) => n + 1);
            }}
          >
            <UserPlus size={16} aria-hidden="true" /> Start onboarding
          </Button>
        </div>

        {loadError && !data ? (
          <EmptyState
            icon={AlertTriangle}
            title="We couldn't load HR data"
            description="Check your connection and try again. If this keeps happening, make sure the latest database migration has been applied."
            action={{ label: 'Try again', onClick: () => void load() }}
          />
        ) : !ctx || !summary ? (
          <div className="space-y-6" aria-busy="true">
            <SkeletonStatGrid count={4} />
            <SkeletonCardList count={3} />
          </div>
        ) : (
          <div className="space-y-6">
            {loadError && (
              <div role="status" className="rounded-xl border border-warning-500/30 bg-warning-500/10 p-3 text-sm text-text-primary">
                The latest refresh failed, so some data may be out of date.{' '}
                <button type="button" className="focus-ring rounded font-semibold text-accent underline" onClick={() => void load()}>
                  Retry
                </button>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile label="Active onboardings" value={summary.activeOnboardings} onClick={() => setTab('onboarding')} />
              <StatTile label="Overdue tasks" value={summary.overdueTasks} tone="alert" onClick={() => setTab('onboarding')} />
              <StatTile label="Documents needed" value={summary.openDocuments} onClick={() => setTab('documents')} />
              <StatTile label="Reviews due" value={summary.reviewsDue} tone="alert" onClick={() => setTab('reviews')} />
            </div>
            {summary.expiringDocuments > 0 && (
              <p role="status" className="rounded-xl border border-warning-500/30 bg-warning-500/10 p-3 text-sm text-text-primary">
                {summary.expiringDocuments} document{summary.expiringDocuments === 1 ? ' is' : 's are'} expired or expiring within 30 days.{' '}
                <button type="button" className="focus-ring rounded font-semibold text-accent underline" onClick={() => setTab('documents')}>
                  Review documents
                </button>
              </p>
            )}

            <div role="tablist" aria-label="HR sections" className="flex gap-1.5 overflow-x-auto pb-1">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`hr-tab-${t.id}`}
                  aria-selected={tab === t.id}
                  aria-controls="hr-tabpanel"
                  onClick={() => setTab(t.id)}
                  className={`focus-ring min-h-[44px] shrink-0 rounded-xl border px-4 text-sm font-semibold transition-colors ${
                    tab === t.id ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-primary text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {t.label}
                  {counts[t.id] > 0 && <span className="ml-2 rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">{counts[t.id]}</span>}
                </button>
              ))}
            </div>

            <div role="tabpanel" id="hr-tabpanel" aria-labelledby={`hr-tab-${tab}`}>
              {tab === 'onboarding' && <OnboardingPanel ctx={ctx} startSignal={startSignal} />}
              {tab === 'documents' && <DocumentsPanel ctx={ctx} />}
              {tab === 'reviews' && <ReviewsPanel ctx={ctx} />}
              {tab === 'templates' && <TemplatesPanel ctx={ctx} />}
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
