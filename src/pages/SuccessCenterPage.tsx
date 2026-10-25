/**
 * Success Center — /dashboard/success
 *
 * Shows the account's feature-adoption score, nudges for unused high-value
 * features, guided activation playbooks and (when due) the NPS question.
 * Everything is derived from real account data; see src/lib/successTools.ts.
 */

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Sparkles } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { Card } from '@/components/ui/Card';
import { AdoptionScoreCard } from '@/components/success/AdoptionScoreCard';
import { NpsForm } from '@/components/success/NpsForm';
import { NudgeList } from '@/components/success/NudgeList';
import { PlaybookCard } from '@/components/success/PlaybookCard';
import { useSuccessSnapshot } from '@/hooks/useSuccessSnapshot';
import type { NpsSubmitResult } from '@/lib/successToolsApi';

export function SuccessCenterPage() {
  const { status, snapshot, view, reload, snoozeNudge, dismissNudge, skipStep, unskipStep } = useSuccessSnapshot();
  const [npsResult, setNpsResult] = useState<NpsSubmitResult | null>(null);

  return (
    <DashboardLayout activeLabel="Success Center">
      <div className="mx-auto max-w-4xl space-y-6">
        <header>
          <div className="flex items-center gap-2">
            <Sparkles className="text-accent" size={22} aria-hidden="true" />
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">Success Center</h1>
          </div>
          <p className="mt-1 text-sm text-text-secondary">See how much of Vireek is working for your business — and the fastest next steps to get more from it.</p>
        </header>

        {status === 'loading' && (
          <div className="space-y-4" aria-busy="true">
            <Card className="space-y-3 p-5 hover:translate-y-0"><Skeleton className="h-24 w-full" /><Skeleton className="h-4 w-2/3" /></Card>
            <Card className="space-y-3 p-5 hover:translate-y-0"><Skeleton className="h-4 w-1/3" /><Skeleton className="h-16 w-full" /></Card>
          </div>
        )}

        {status === 'error' && (
          <EmptyState icon={AlertTriangle} title="Couldn’t load your Success Center" description="The request didn’t complete. Nothing was changed." action={{ label: 'Retry', onClick: () => void reload() }} />
        )}

        {status === 'ready' && view && snapshot && (
          <>
            <AdoptionScoreCard adoption={view.adoption} />

            {view.nudges.length > 0 && (
              <section aria-labelledby="success-next" className="space-y-3">
                <h2 id="success-next" className="text-sm font-bold text-text-primary">Recommended next</h2>
                <NudgeList nudges={view.nudges} onSnooze={(k) => void snoozeNudge(k)} onDismiss={(k) => void dismissNudge(k)} />
              </section>
            )}

            <section aria-labelledby="success-playbooks" className="space-y-3">
              <h2 id="success-playbooks" className="text-sm font-bold text-text-primary">Guided playbooks</h2>
              <div className="grid gap-4 lg:grid-cols-2">
                {view.playbooks.map((p) => (
                  <PlaybookCard key={p.def.id} progress={p} highlighted={view.activePlaybook?.def.id === p.def.id} onSkip={(pb, st) => void skipStep(pb, st)} onUnskip={(pb, st) => void unskipStep(pb, st)} />
                ))}
              </div>
            </section>

            {snapshot.npsDue && !npsResult && (
              <Card className="space-y-3 p-5 hover:translate-y-0">
                <h2 className="text-sm font-bold text-text-primary">Help us improve Vireek</h2>
                <NpsForm context="success_center" onDone={setNpsResult} />
              </Card>
            )}
            {npsResult?.ok && (
              <p role="status" className="flex items-center gap-2 rounded-xl bg-success-500/10 p-3 text-sm text-text-primary">
                <CheckCircle2 size={16} className="text-success-500" aria-hidden="true" /> Thank you — your feedback goes straight to our team.
              </p>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
