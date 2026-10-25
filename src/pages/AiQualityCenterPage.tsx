import { useCallback, useEffect, useMemo, useState } from 'react';
import { Gauge, Lock } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { SkeletonCard } from '@/components/Skeleton';
import { QualityOverviewTab } from '@/components/quality/QualityOverviewTab';
import { QualityCallsTab } from '@/components/quality/QualityCallsTab';
import { QualityFixesTab } from '@/components/quality/QualityFixesTab';
import { ComplianceRulesTab } from '@/components/quality/ComplianceRulesTab';
import { CopilotQualityTab } from '@/components/quality/CopilotQualityTab';
import { btnGhost } from '@/components/quality/qualityUi';
import {
  applyFix,
  deleteRule,
  ensureDefaultRules,
  fetchFeed,
  fetchFindings,
  fetchFixes,
  fetchOverview,
  fetchRules,
  friendlyError,
  rejectFix,
  runReview,
  saveRule,
  setFindingStatus,
  setRuleEnabled,
  type QualityFinding,
  type QualityFix,
  type QualityOverview,
  type QualityReviewRow,
  type QualityRule,
  type RuleInput,
} from '@/lib/callQuality';

const DAY = 86_400_000;
const MAX_ROUNDS = 6;
type TabId = 'overview' | 'calls' | 'fixes' | 'rules' | 'copilot';

export function AiQualityCenterPage() {
  const { isOwner, permissions, profile, loading, profileLoading } = useAuth();
  const { toast } = useToast();
  const canAccess = isOwner || permissions.can_edit_business_profile;

  const [tab, setTab] = useState<TabId>('overview');
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [reviews, setReviews] = useState<QualityReviewRow[]>([]);
  const [findings, setFindings] = useState<QualityFinding[]>([]);
  const [fixes, setFixes] = useState<QualityFix[]>([]);
  const [rules, setRules] = useState<QualityRule[]>([]);
  const [overview, setOverview] = useState<QualityOverview | null>(null);
  const [busy, setBusy] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [fixBusy, setFixBusy] = useState<string | null>(null);
  const [rereviewing, setRereviewing] = useState<string | null>(null);

  const range = useCallback((d: number) => ({ from: new Date(Date.now() - d * DAY).toISOString(), to: new Date(Date.now() + 60_000).toISOString() }), []);

  const loadAll = useCallback(async () => {
    setLoadError(null);
    try { await ensureDefaultRules(); } catch { /* rules still load below */ }
    const r90 = range(90);
    const [feed, fnd, fx, rl] = await Promise.allSettled([fetchFeed(r90.from, r90.to), fetchFindings('open'), fetchFixes('proposed'), fetchRules()]);
    if (feed.status === 'fulfilled') setReviews(feed.value);
    if (fnd.status === 'fulfilled') setFindings(fnd.value);
    if (fx.status === 'fulfilled') setFixes(fx.value);
    if (rl.status === 'fulfilled') setRules(rl.value);
    const failed = [feed, fnd, fx, rl].find((x) => x.status === 'rejected') as PromiseRejectedResult | undefined;
    if (failed) setLoadError(await friendlyError(failed.reason, 'Some quality data could not be loaded.'));
  }, [range]);

  const loadOverview = useCallback(async (d: number) => {
    try {
      const r = range(d);
      setOverview(await fetchOverview(r.from, r.to));
    } catch (e) {
      setLoadError(await friendlyError(e, 'Could not load coverage.'));
    }
  }, [range]);

  useEffect(() => {
    if (!canAccess || loading || profileLoading) return;
    let alive = true;
    (async () => {
      setBusy(true);
      await loadAll();
      if (alive) setBusy(false);
    })();
    return () => { alive = false; };
  }, [canAccess, loading, profileLoading, loadAll]);

  useEffect(() => {
    if (canAccess && !loading && !profileLoading) void loadOverview(days);
  }, [canAccess, loading, profileLoading, days, loadOverview]);

  const windowReviews = useMemo(() => {
    const from = Date.now() - days * DAY;
    return reviews.filter((r) => Date.parse(r.call_at) >= from);
  }, [reviews, days]);

  const refresh = useCallback(async () => {
    await Promise.all([loadAll(), loadOverview(days)]);
  }, [loadAll, loadOverview, days]);

  const handleRunReview = async () => {
    setRunning(true);
    let total = 0;
    let failed = 0;
    try {
      for (let round = 1; round <= MAX_ROUNDS; round++) {
        setProgress(`Reviewing… ${total} done`);
        const res = await runReview({ backfill: true, days: Math.min(days, 30), limit: 8 });
        total += res.reviewed;
        failed += res.failed;
        if (res.remaining === 0 || res.reviewed === 0) break;
      }
      toast(total ? `Reviewed ${total} call${total === 1 ? '' : 's'}${failed ? ` (${failed} failed — try again)` : ''}.` : failed ? 'Reviews failed. Please try again.' : 'Nothing new to review.', failed && !total ? 'error' : 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Review failed.', 'error');
    } finally {
      setRunning(false);
      setProgress(null);
      await refresh();
    }
  };

  const handleRereview = async (callId: string) => {
    setRereviewing(callId);
    try {
      const res = await runReview({ callIds: [callId], force: true });
      toast(res.reviewed ? 'Call re-reviewed.' : 'This call can’t be reviewed (transcript too short or unclear).', res.reviewed ? 'success' : 'info');
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Re-review failed.', 'error');
    } finally {
      setRereviewing(null);
    }
  };

  const handleApply: Parameters<typeof QualityFixesTab>[0]['onApply'] = async (fix, overrides) => {
    setFixBusy(fix.id);
    try {
      const res = await applyFix(fix.id, overrides);
      const resolved = res.findings_resolved > 1 ? ` ${res.findings_resolved} issues resolved.` : '';
      if (res.type === 'kb_article') toast(`Published to your Knowledge Base${res.updated_existing ? ' (existing article updated)' : ''}.${resolved}`, 'success');
      else if (res.changed === false) toast(`That instruction was already in the script.${resolved}`, 'info');
      else if (res.live) toast(`Script updated and live.${resolved}`, 'success');
      else toast('Saved as a new script version, but not live because an A/B test is running. Publish it in Call Scripts.', 'info');
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not apply the fix.', 'error');
    } finally {
      setFixBusy(null);
    }
  };

  const handleReject = async (fix: QualityFix) => {
    setFixBusy(fix.id);
    try {
      await rejectFix(fix.id);
      toast('Fix dismissed.', 'info');
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not dismiss the fix.', 'error');
    } finally {
      setFixBusy(null);
    }
  };

  const handleDismissFinding = async (id: string) => {
    try {
      await setFindingStatus(id, 'dismissed');
      toast('Dismissed. It will not be flagged again on this call.', 'info');
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not dismiss.', 'error');
    }
  };

  const reloadRules = async () => setRules(await fetchRules());
  const handleSaveRule = async (id: string | null, input: RuleInput) => { await saveRule(id, input); await reloadRules(); toast('Rule saved. It applies to new reviews.', 'success'); };
  const handleToggleRule = async (r: QualityRule) => {
    try { await setRuleEnabled(r.id, !r.enabled); await reloadRules(); } catch (e) { toast(e instanceof Error ? e.message : 'Could not update the rule.', 'error'); }
  };
  const handleDeleteRule = async (r: QualityRule) => {
    try { await deleteRule(r.id); await reloadRules(); toast('Rule deleted.', 'info'); } catch (e) { toast(e instanceof Error ? e.message : 'Could not delete the rule.', 'error'); }
  };

  if (loading || profileLoading) {
    return <DashboardLayout activeLabel="AI Quality"><SkeletonCard rows={4} /></DashboardLayout>;
  }

  if (!canAccess || !profile) {
    return (
      <DashboardLayout activeLabel="AI Quality">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">The AI Quality Center can change your scripts and Knowledge Base. Ask your account owner for the “Edit Business Profile” permission.</p>
        </div>
      </DashboardLayout>
    );
  }

  const TABS: { id: TabId; label: string; badge?: number }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'calls', label: 'Scorecards', badge: findings.length || undefined },
    { id: 'fixes', label: 'One-click fixes', badge: fixes.length || undefined },
    { id: 'rules', label: 'Compliance phrases' },
    { id: 'copilot', label: 'Field Copilot' },
  ];

  return (
    <DashboardLayout activeLabel="AI Quality">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Gauge size={24} /></span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">AI Quality Center</h1>
            <p className="text-sm text-text-secondary">Scorecards for every call, flagged mistakes, and one-click fixes to your Knowledge Base and scripts.</p>
          </div>
        </div>
        <select aria-label="Time range" value={days} onChange={(e) => setDays(Number(e.target.value) as 7 | 30 | 90)} className="focus-ring rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary">
          <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
        </select>
      </div>

      <div role="tablist" aria-label="Quality sections" className="mb-6 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={`focus-ring inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-semibold transition-colors ${tab === t.id ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}>
            {t.label}
            {t.badge !== undefined && <span className="rounded-full bg-danger/10 px-1.5 text-xs font-bold text-danger">{t.badge}</span>}
          </button>
        ))}
      </div>

      {loadError && (
        <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          <span>{loadError}</span>
          <button onClick={() => void refresh()} className={btnGhost}>Retry</button>
        </div>
      )}

      {busy ? (
        <SkeletonCard rows={5} />
      ) : (
        <>
          {tab === 'overview' && <QualityOverviewTab allReviews={reviews} windowReviews={windowReviews} findings={findings} overview={overview} running={running} progress={progress} onRunReview={handleRunReview} />}
          {tab === 'calls' && <QualityCallsTab reviews={windowReviews} findings={findings} rereviewing={rereviewing} onRereview={handleRereview} onDismiss={handleDismissFinding} />}
          {tab === 'fixes' && <QualityFixesTab fixes={fixes} findings={findings} busyId={fixBusy} onApply={handleApply} onReject={handleReject} />}
          {tab === 'rules' && <ComplianceRulesTab rules={rules} onSave={handleSaveRule} onToggle={handleToggleRule} onDelete={handleDeleteRule} />}
          {tab === 'copilot' && <CopilotQualityTab stats={overview?.copilot ?? null} />}
        </>
      )}
    </DashboardLayout>
  );
}
