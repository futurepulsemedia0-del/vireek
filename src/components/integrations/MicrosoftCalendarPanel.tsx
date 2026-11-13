// src/components/integrations/MicrosoftCalendarPanel.tsx
//
// Per-calendar status list shown inside the "Microsoft 365 / Outlook" card on the Integrations page.
// Lists every active connection (office first, then technicians) with its health, and lets the person
// sync now, reconnect (after revoked/expired access) or disconnect. Connecting the *office* calendar
// stays on the card's own Connect button (see IntegrationsPage.handleOAuthConnect).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader as Loader2, RefreshCw, TriangleAlert as AlertTriangle } from 'lucide-react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import {
  connectionTitle,
  describeConnection,
  sortConnections,
  type ConnectionTone,
  type MicrosoftCalendarConnection,
} from '@/lib/microsoftCalendar';
import {
  disconnectMicrosoftCalendar,
  listMicrosoftCalendarConnections,
  startMicrosoftCalendarConnect,
  syncMicrosoftCalendarNow,
  type MicrosoftSyncResult,
} from '@/lib/microsoftCalendarApi';

interface MicrosoftCalendarPanelProps {
  /** Bump to force a reload (e.g. after the OAuth redirect or a disconnect from the card). */
  refreshKey?: number;
  /** Called after this panel changes something, so the parent can reload its own integration rows. */
  onChanged?: () => void | Promise<void>;
}

const TONE_CLASS: Record<ConnectionTone, string> = {
  ok: 'bg-success-500/10 text-success-500',
  warn: 'bg-warning-500/10 text-warning-500',
  error: 'bg-danger/10 text-danger',
};

const buttonClass =
  'focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50';

function summarizeSync(results: MicrosoftSyncResult[]): { message: string; type: 'success' | 'error' | 'info' } {
  if (results.length === 0) return { message: 'Nothing to sync yet.', type: 'info' };
  if (results.some((r) => r.status === 'needs_reconnect')) {
    return { message: 'Microsoft access expired. Reconnect this calendar to resume syncing.', type: 'error' };
  }
  if (results.every((r) => r.status === 'busy')) {
    return { message: 'A sync is already running. Try again in a moment.', type: 'info' };
  }
  if (results.some((r) => r.status === 'error')) {
    return { message: 'Sync hit an error. Vireek will retry automatically.', type: 'error' };
  }
  const sum = (k: 'created' | 'updated' | 'deleted' | 'reschedules') => results.reduce((n, r) => n + (r[k] ?? 0), 0);
  const parts: string[] = [];
  if (sum('created')) parts.push(`${sum('created')} added`);
  if (sum('updated')) parts.push(`${sum('updated')} updated`);
  if (sum('deleted')) parts.push(`${sum('deleted')} removed`);
  if (sum('reschedules')) parts.push(`${sum('reschedules')} rescheduled from Outlook`);
  const partial = results.some((r) => r.status === 'partial');
  const base = parts.length ? `Calendar synced: ${parts.join(', ')}.` : 'Calendar is up to date.';
  return { message: partial ? `${base} Some items will be retried.` : base, type: 'success' };
}

export function MicrosoftCalendarPanel({ refreshKey = 0, onChanged }: MicrosoftCalendarPanelProps) {
  const { toast } = useToast();
  const [connections, setConnections] = useState<MicrosoftCalendarConnection[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDisconnect, setPendingDisconnect] = useState<MicrosoftCalendarConnection | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const list = await listMicrosoftCalendarConnections();
      if (seq !== requestSeq.current) return; // a newer load superseded this one
      setConnections(sortConnections(list));
      setLoadError(null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setLoadError(err instanceof Error ? err.message : 'Could not load Microsoft 365 calendars.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const notifyParent = useCallback(async () => {
    try {
      await onChanged?.();
    } catch {
      /* the parent reports its own load errors */
    }
  }, [onChanged]);

  const handleSync = async (c: MicrosoftCalendarConnection) => {
    if (busyId) return;
    setBusyId(c.id);
    try {
      const { message, type } = summarizeSync(await syncMicrosoftCalendarNow(c.id));
      toast(message, type);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not sync Microsoft 365.', 'error');
    } finally {
      setBusyId(null);
      await load();
      await notifyParent();
    }
  };

  const handleReconnect = async (c: MicrosoftCalendarConnection) => {
    if (busyId) return;
    setBusyId(c.id);
    try {
      await startMicrosoftCalendarConnect(c.scope); // navigates away on success
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not connect Microsoft 365.', 'error');
      setBusyId(null);
    }
  };

  const handleConfirmDisconnect = async () => {
    const target = pendingDisconnect;
    if (!target || busyId) return;
    setBusyId(target.id);
    try {
      await disconnectMicrosoftCalendar(target.id, false);
      toast(`${connectionTitle(target)} disconnected. Existing Outlook events were left in place.`, 'info');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not disconnect Microsoft 365. Please try again.', 'error');
    } finally {
      setBusyId(null);
      setPendingDisconnect(null);
      await load();
      await notifyParent();
    }
  };

  if (loadError) {
    return (
      <div className="mt-4 flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/10 p-3" role="alert">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-text-primary">{loadError}</p>
          <button type="button" onClick={() => void load()} className={`${buttonClass} mt-2`}>
            <RefreshCw size={12} aria-hidden="true" /> Try again
          </button>
        </div>
      </div>
    );
  }

  if (connections === null) {
    return (
      <div className="mt-4 flex items-center gap-2 text-xs text-text-secondary" role="status">
        <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Loading calendars…
      </div>
    );
  }

  if (connections.length === 0) return null;

  return (
    <div className="mt-4 space-y-2" aria-label="Connected Microsoft 365 calendars">
      {connections.map((c) => {
        const info = describeConnection(c);
        const busy = busyId === c.id;
        return (
          <div key={c.id} className="rounded-xl border border-border bg-bg-primary p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text-primary">{connectionTitle(c)}</p>
                {c.ms_email && <p className="truncate text-xs text-text-secondary">{c.ms_email}</p>}
              </div>
              <span className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-medium ${TONE_CLASS[info.tone]}`}>
                {info.label}
              </span>
            </div>
            <p className="mt-1.5 text-xs text-text-secondary">{info.detail}</p>
            {info.tone !== 'ok' && c.last_error_message && (
              <p className="mt-1 break-words text-xs text-text-secondary">{c.last_error_message}</p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {c.status === 'error' ? (
                <button type="button" onClick={() => void handleReconnect(c)} disabled={busyId !== null} className={buttonClass}>
                  {busy ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : null}
                  Reconnect
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleSync(c)}
                  disabled={busyId !== null}
                  aria-label={`Sync ${connectionTitle(c)} now`}
                  className={buttonClass}
                >
                  {busy ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={12} aria-hidden="true" />}
                  Sync now
                </button>
              )}
              <button
                type="button"
                onClick={() => setPendingDisconnect(c)}
                disabled={busyId !== null}
                aria-label={`Disconnect ${connectionTitle(c)}`}
                className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
              >
                Disconnect
              </button>
            </div>
          </div>
        );
      })}

      <ConfirmDialog
        open={pendingDisconnect !== null}
        title={pendingDisconnect ? `Disconnect ${connectionTitle(pendingDisconnect)}?` : 'Disconnect calendar?'}
        description="Vireek will stop syncing jobs with this Microsoft 365 calendar right away. You can reconnect at any time."
        confirmLabel="Yes, disconnect"
        consequences={['Stop syncing jobs to Outlook', 'Stop blocking time for Outlook events', 'Existing Outlook events stay in place']}
        onConfirm={handleConfirmDisconnect}
        onCancel={() => setPendingDisconnect(null)}
      />
    </div>
  );
}
