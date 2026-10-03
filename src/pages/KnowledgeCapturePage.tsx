/**
 * Knowledge Capture Engine — /dashboard/knowledge-capture
 *
 * Turns what senior technicians know (calls, notes, diagnoses, expert sessions, outcomes,
 * corrections, voice/video) into governed, versioned, confidence-scored tribal rules.
 * Lifecycle: candidate → in review → approved → live (deployed), or rejected / retired.
 * Distinct from the Knowledge Base (articles); deploying mirrors a rule into it for retrieval.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Brain, CheckCircle2, ClipboardCheck, Gauge, Radio, Users } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton, SkeletonStatGrid } from '@/components/Skeleton';
import { CapturePanel } from '@/components/knowledge-capture/CapturePanel';
import { ExpertRiskPanel } from '@/components/knowledge-capture/ExpertRiskPanel';
import { RuleCard } from '@/components/knowledge-capture/RuleCard';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  STATUS_LABELS,
  type AvailableAction,
  type KceOverview,
  type KceRule,
  type KceStatus,
} from '@/lib/knowledgeCapture';
import {
  deployRule,
  fetchOverview,
  fetchRules,
  retireRule,
  reviewRule,
  type RuleEdits,
} from '@/lib/knowledgeCaptureApi';

type Tab = 'queue' | 'live' | 'capture' | 'risk';

const QUEUE_STATUSES: KceStatus[] = ['candidate', 'in_review', 'approved'];
const ARCHIVE_STATUSES: KceStatus[] = ['rejected', 'retired'];

const SUCCESS_MESSAGES: Record<string, string> = {
  start_review: 'Moved to review.',
  approve: 'Approved. It can now be deployed.',
  reject: 'Rejected.',
  revise: 'Saved as a new version and sent back for review.',
  deploy: 'Deployed — technicians can use it now.',
  retire: 'Retired and removed from the field.',
};

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border/80 bg-bg-secondary px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-text-secondary">{hint}</p>}
    </div>
  );
}

export function KnowledgeCapturePage() {
  const { isOwner, teamMember, permissions } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('queue');
  const [overview, setOverview] = useState<KceOverview | null>(null);
  const [rules, setRules] = useState<KceRule[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showArchive, setShowArchive] = useState(false);

  const isReviewer = isOwner || permissions.can_manage_team;
  const ctx = useMemo(
    () => ({
      canReview: isReviewer,
      isOwner,
      myMemberId: isOwner ? null : (teamMember?.id ?? null),
    }),
    [isReviewer, isOwner, teamMember?.id],
  );

  const load = useCallback(async () => {
    try {
      const [o, r] = await Promise.all([fetchOverview(), fetchRules()]);
      setOverview(o);
      setRules(r);
      setLoadError(false);
    } catch {
      setLoadError(true);
      setRules((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // Technicians only get the live view + capture form.
    if (!isReviewer && (tab === 'queue' || tab === 'risk')) setTab('live');
  }, [isReviewer, tab]);

  const handleAction = useCallback(
    async (
      rule: KceRule,
      action: AvailableAction['action'],
      note: string,
      edits?: RuleEdits,
    ): Promise<boolean> => {
      setBusyId(rule.id);
      try {
        let updated: KceRule;
        if (action === 'deploy') updated = await deployRule(rule.id, note);
        else if (action === 'retire') updated = await retireRule(rule.id, note);
        else updated = await reviewRule(rule.id, action, note, edits);
        setRules((prev) => (prev ?? []).map((r) => (r.id === updated.id ? updated : r)));
        toast(SUCCESS_MESSAGES[action] ?? 'Done.', 'success');
        void fetchOverview()
          .then(setOverview)
          .catch(() => undefined);
        return true;
      } catch (e) {
        toast(e instanceof Error ? e.message : 'That action failed.', 'error');
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [toast],
  );

  const groups = useMemo(() => {
    const list = rules ?? [];
    const by = (statuses: KceStatus[]) => list.filter((r) => statuses.includes(r.status));
    const queue = by(QUEUE_STATUSES).sort(
      (a, b) =>
        QUEUE_STATUSES.indexOf(a.status) - QUEUE_STATUSES.indexOf(b.status) ||
        b.confidence_score - a.confidence_score,
    );
    const live = by(['deployed']).sort(
      (a, b) =>
        Number(b.needs_revalidation) - Number(a.needs_revalidation) ||
        b.confidence_score - a.confidence_score,
    );
    return { queue, live, archive: by(ARCHIVE_STATUSES) };
  }, [rules]);

  const tabs: { id: Tab; label: string; icon: typeof Brain; count?: number; hidden?: boolean }[] = [
    {
      id: 'queue',
      label: 'Review queue',
      icon: ClipboardCheck,
      count: groups.queue.length,
      hidden: !isReviewer,
    },
    { id: 'live', label: 'Live in the field', icon: Radio, count: groups.live.length },
    { id: 'capture', label: 'Capture', icon: Brain },
    { id: 'risk', label: 'Retirement risk', icon: Users, hidden: !isReviewer },
  ];

  const renderRules = (list: KceRule[], empty: { title: string; description: string }) =>
    list.length === 0 ? (
      <EmptyState icon={CheckCircle2} title={empty.title} description={empty.description} />
    ) : (
      <div className="space-y-3">
        {list.map((r) => (
          <RuleCard key={r.id} rule={r} ctx={ctx} busy={busyId === r.id} onAction={handleAction} />
        ))}
      </div>
    );

  const deployedCount = overview?.status_counts?.deployed ?? groups.live.length;

  return (
    <DashboardLayout activeLabel="Knowledge Capture">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
            <Brain size={22} className="text-accent" aria-hidden="true" /> Knowledge Capture Engine
          </h1>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-text-secondary">
            Your senior technicians' instincts, captured before they walk out the door. Vireek
            extracts tribal rules from real work — then every rule is reviewed, versioned,
            confidence-scored and only then deployed to your team.
          </p>
        </header>

        {rules === null ? (
          <SkeletonStatGrid count={4} className="mb-6" />
        ) : (
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Live rules"
              value={deployedCount}
              hint={
                overview?.avg_confidence_deployed != null
                  ? `avg confidence ${overview.avg_confidence_deployed}%`
                  : undefined
              }
            />
            {isReviewer && (
              <Stat
                label="Awaiting review"
                value={groups.queue.length}
                hint={`${overview?.pending_captures ?? 0} sources queued`}
              />
            )}
            {isReviewer && (
              <Stat
                label="Needs revalidation"
                value={overview?.needs_revalidation ?? 0}
                hint="live rules failing in the field"
              />
            )}
            {isReviewer && (
              <Stat
                label="Field success (90d)"
                value={
                  (overview?.applications_90d ?? 0) === 0
                    ? '—'
                    : `${Math.round(((overview?.resolved_90d ?? 0) / (overview?.applications_90d ?? 1)) * 100)}%`
                }
                hint={`${overview?.applications_90d ?? 0} recorded uses`}
              />
            )}
          </div>
        )}

        {loadError && (
          <p
            role="alert"
            className="mb-4 rounded-xl border border-danger/25 bg-danger/10 px-4 py-3 text-sm text-danger"
          >
            Couldn't load everything. Refresh to try again — if it keeps happening, the Knowledge
            Capture migration may not be applied yet.
          </p>
        )}

        <div
          role="tablist"
          aria-label="Knowledge capture sections"
          className="mb-5 flex flex-wrap gap-1 border-b border-border"
        >
          {tabs
            .filter((t) => !t.hidden)
            .map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`kce-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`kce-panel-${t.id}`}
                onClick={() => setTab(t.id)}
                className={`focus-ring -mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${tab === t.id ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
              >
                <t.icon size={15} aria-hidden="true" /> {t.label}
                {t.count !== undefined && (
                  <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] tabular-nums">
                    {t.count}
                  </span>
                )}
              </button>
            ))}
        </div>

        <div role="tabpanel" id={`kce-panel-${tab}`} aria-labelledby={`kce-tab-${tab}`}>
          {rules === null && <Skeleton className="h-48 w-full" />}

          {rules !== null && tab === 'queue' && (
            <>
              {renderRules(groups.queue, {
                title: 'Review queue is clear',
                description:
                  'New candidate rules appear here after a scan or a captured voice note.',
              })}
              {groups.archive.length > 0 && (
                <div className="mt-6">
                  <button
                    type="button"
                    onClick={() => setShowArchive((v) => !v)}
                    aria-expanded={showArchive}
                    className="focus-ring rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10"
                  >
                    {showArchive ? 'Hide' : 'Show'} {groups.archive.length} rejected / retired
                  </button>
                  {showArchive && (
                    <div className="mt-3 space-y-3">
                      {groups.archive.map((r) => (
                        <RuleCard
                          key={r.id}
                          rule={r}
                          ctx={ctx}
                          busy={false}
                          onAction={handleAction}
                        />
                      ))}
                    </div>
                  )}
                  {showArchive && (
                    <p className="mt-2 text-xs text-text-secondary">
                      {STATUS_LABELS.rejected} and {STATUS_LABELS.retired.toLowerCase()} rules never
                      reach technicians.
                    </p>
                  )}
                </div>
              )}
            </>
          )}

          {rules !== null &&
            tab === 'live' &&
            renderRules(groups.live, {
              title: 'No rules are live yet',
              description:
                'Approve and deploy a candidate and it will be offered to technicians on matching jobs.',
            })}

          {tab === 'capture' && (
            <CapturePanel overview={overview} isReviewer={isReviewer} onChanged={load} />
          )}

          {tab === 'risk' && isReviewer && <ExpertRiskPanel />}
        </div>

        <p className="mt-8 flex items-center gap-1.5 text-[11px] text-text-secondary">
          <Gauge size={12} aria-hidden="true" /> Confidence blends evidence specificity, independent
          corroboration, real field outcomes, human verification and freshness. Rules below 40%
          can't be deployed.
        </p>
      </div>
    </DashboardLayout>
  );
}
