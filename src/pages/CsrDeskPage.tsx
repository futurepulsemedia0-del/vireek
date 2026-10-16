import { useEffect, useState } from 'react';
import { AlertTriangle, Headset, Lock, PhoneCall, PhoneOff, RefreshCw, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { LiveIndicator } from '@/components/LiveIndicator';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ScreenPopPanel } from '@/components/csr/ScreenPopPanel';
import { CsrActions } from '@/components/csr/CsrActions';
import { useCsrScreenPop } from '@/hooks/useCsrScreenPop';
import { elapsedLabel, formatPhone, type DeskCall } from '@/lib/csrScreenPop';

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function QueueItem({ call, active, now, onSelect, onDismiss }: { call: DeskCall; active: boolean; now: number; onSelect: () => void; onDismiss: () => void }) {
  return (
    <li>
      <div
        className={`flex items-stretch rounded-xl border transition-colors ${
          active ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary hover:border-accent/40'
        }`}
      >
        <button type="button" onClick={onSelect} aria-current={active ? 'true' : undefined} className="focus-ring min-w-0 flex-1 rounded-xl p-3 text-left">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-semibold text-text-primary">{call.caller_name ?? formatPhone(call.caller_phone)}</span>
            <span className={`shrink-0 text-xs font-medium tabular-nums ${call.ended ? 'text-text-secondary' : 'text-success-500'}`}>
              {call.ended ? 'Ended' : elapsedLabel(call.call_datetime, now)}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {call.is_emergency && <span className="rounded-full bg-danger/10 px-2 py-0.5 text-xs font-semibold text-danger">Emergency</span>}
            {call.human_transfer_requested && <span className="rounded-full bg-warning-500/15 px-2 py-0.5 text-xs font-semibold text-warning-500">Wants a person</span>}
            {call.caller_name && <span className="text-xs text-text-secondary">{formatPhone(call.caller_phone)}</span>}
          </div>
        </button>
        {call.ended && (
          <button type="button" onClick={onDismiss} className="focus-ring m-1 rounded-lg px-2 text-text-secondary hover:text-text-primary" aria-label="Dismiss ended call">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </li>
  );
}

export function CsrDeskPage() {
  const { isOwner, profile, teamMember, permissions } = useAuth();
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const allowed = permissions.can_view_all_jobs;
  const desk = useCsrScreenPop(allowed ? ownerId : undefined);
  const now = useNow(1000);

  // Make a new call impossible to miss when another one is open / tab is hidden.
  useEffect(() => {
    if (!desk.incomingId) return;
    const original = document.title;
    document.title = '📞 Incoming call — Vireek';
    return () => {
      document.title = original;
    };
  }, [desk.incomingId]);

  if (!allowed) {
    return (
      <DashboardLayout activeLabel="CSR Phone Desk">
        <EmptyState icon={Lock} title="You don't have access to the phone desk" description="Ask your account owner to grant the “view all jobs” permission." />
      </DashboardLayout>
    );
  }

  const live = desk.calls.filter((c) => !c.ended).length;

  return (
    <DashboardLayout activeLabel="CSR Phone Desk">
      <div className="mx-auto max-w-7xl space-y-5 p-4 sm:p-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <Headset className="h-6 w-6 text-accent" aria-hidden="true" /> CSR Phone Desk
            </h1>
            <p className="mt-1 text-sm text-text-secondary">Caller details appear the moment a call connects.</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-text-secondary" aria-live="polite">{live} live call{live === 1 ? '' : 's'}</span>
            <LiveIndicator status={desk.realtime} />
          </div>
        </header>

        {desk.incomingId && (
          <div role="status" className="flex items-center justify-between gap-3 rounded-xl border border-accent/40 bg-accent/10 p-3 text-sm">
            <span className="flex items-center gap-2 font-semibold text-text-primary">
              <PhoneCall className="h-4 w-4 text-accent" aria-hidden="true" /> A new call just came in.
            </span>
            <Button size="sm" variant="primary" onClick={() => desk.select(desk.incomingId)}>Open it</Button>
          </div>
        )}

        {desk.queueError && (
          <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
            <span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" aria-hidden="true" /> {desk.queueError}</span>
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
          {/* Queue */}
          <aside aria-label="Live calls">
            {desk.queueLoading ? (
              <div className="space-y-2"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
            ) : desk.calls.length === 0 ? (
              <Card className="!p-5 text-center hover:!translate-y-0">
                <PhoneOff className="mx-auto h-8 w-8 text-text-secondary" aria-hidden="true" />
                <p className="mt-2 text-sm font-semibold text-text-primary">No calls right now</p>
                <p className="mt-1 text-xs text-text-secondary">When a call connects it will pop up here automatically.</p>
              </Card>
            ) : (
              <ul className="space-y-2">
                {desk.calls.map((c) => (
                  <QueueItem key={c.id} call={c} active={c.id === desk.selectedId} now={now} onSelect={() => desk.select(c.id)} onDismiss={() => desk.dismiss(c.id)} />
                ))}
              </ul>
            )}
          </aside>

          {/* Screen-pop */}
          <section aria-label="Caller details" className="min-w-0">
            {!desk.selectedCall ? (
              <Card className="!p-10 text-center hover:!translate-y-0">
                <Headset className="mx-auto h-10 w-10 text-text-secondary" aria-hidden="true" />
                <p className="mt-3 font-semibold text-text-primary">Select a call to see the caller</p>
              </Card>
            ) : desk.popLoading && !desk.data ? (
              <div className="space-y-3" aria-busy="true"><Skeleton className="h-28 w-full" /><Skeleton className="h-40 w-full" /><Skeleton className="h-32 w-full" /></div>
            ) : desk.popError && !desk.data ? (
              <Card className="!p-6 text-center hover:!translate-y-0">
                <AlertTriangle className="mx-auto h-8 w-8 text-danger" aria-hidden="true" />
                <p className="mt-2 text-sm text-text-primary">{desk.popError}</p>
                <Button size="sm" variant="secondary" className="mt-3" onClick={desk.retryPop}><RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again</Button>
              </Card>
            ) : desk.data && ownerId ? (
              <div className="space-y-4">
                <CsrActions ownerId={ownerId} call={desk.selectedCall} data={desk.data} />
                <ScreenPopPanel call={desk.selectedCall} data={desk.data} canViewBilling={permissions.can_view_billing} now={now} />
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </DashboardLayout>
  );
}
