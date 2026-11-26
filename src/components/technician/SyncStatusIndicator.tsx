import { AlertTriangle, CheckCircle2, CloudOff, Loader2, RefreshCw, UploadCloud } from 'lucide-react';
import { useSyncState } from '@/hooks/useFieldSync';
import { describeSync, type SyncKind, type SyncTone } from '@/lib/offline/syncStatusModel';
import { requestSync } from '@/lib/offline/sync';

const TONE: Record<SyncTone, string> = {
  ok: 'border-success/30 bg-success-subtle',
  info: 'border-border bg-bg-secondary',
  warning: 'border-warning/40 bg-warning-subtle',
  danger: 'border-danger/40 bg-danger-subtle',
};

const ICON: Record<SyncKind, typeof CloudOff> = {
  needs_sign_in: AlertTriangle, conflict: AlertTriangle, failed: AlertTriangle,
  offline: CloudOff, syncing: Loader2, waiting: UploadCloud, synced: CheckCircle2,
};

/** One-line sync status for the technician screens. Polite live region; retry only when it helps. */
export function SyncStatusIndicator({ className = '' }: { className?: string }) {
  const sync = useSyncState();
  const view = describeSync(sync);
  const Icon = ICON[view.kind];
  const canRetry = sync.online && !sync.syncing && !sync.needsSignIn && view.count > 0;

  return (
    <div role="status" aria-live="polite" data-sync-kind={view.kind} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm text-text-primary ${TONE[view.tone]} ${className}`}>
      <Icon className={`h-4 w-4 shrink-0 ${view.kind === 'syncing' ? 'motion-safe:animate-spin' : ''}`} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{view.label}</span>
        {view.detail && <span className="block text-xs text-text-secondary">{view.detail}</span>}
      </span>
      {canRetry && (
        <button type="button" onClick={() => requestSync()} className="focus-ring inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-border bg-bg-secondary px-3 text-xs font-semibold text-text-primary">
          <RefreshCw className="h-3 w-3" aria-hidden="true" />
          Sync now
        </button>
      )}
    </div>
  );
}
