import { useCallback, useEffect, useState } from 'react';
import { Loader as Loader2, RefreshCw, Link2, Link2Off, AlertTriangle, Check, User } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  describeConnection,
  connectionTitle,
  sortConnections,
  type MicrosoftCalendarConnection,
} from '@/lib/microsoftCalendar';
import {
  disconnectMicrosoftCalendar,
  listMicrosoftCalendarConnections,
  startMicrosoftCalendarConnect,
  syncMicrosoftCalendarNow,
} from '@/lib/microsoftCalendarApi';

interface Props {
  /** Bump to reload (e.g. after returning from the Microsoft sign-in). */
  refreshKey: number;
  onChanged: () => void;
}

const TONE_CLASS = {
  ok: 'bg-success-500/10 text-success-500',
  warn: 'bg-warning-500/10 text-warning-500',
  error: 'bg-danger-500/10 text-danger-500',
} as const;

export function MicrosoftCalendarPanel({ refreshKey, onChanged }: Props) {
  const { teamMember } = useAuth();
  const { toast } = useToast();
  const [rows, setRows] = useState<MicrosoftCalendarConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleteEvents, setDeleteEvents] = useState(false);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      setRows(sortConnections(await listMicrosoftCalendarConnections()));
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const myTechnicianId = teamMember?.id ?? null;
  const hasMine = myTechnicianId ? rows.some((r) => r.team_member_id === myTechnicianId) : false;

  const run = async (id: string, action: () => Promise<void>, failure: string) => {
    setBusyId(id);
    try {
      await action();
    } catch (err) {
      toast(err instanceof Error ? err.message : failure, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleSync = (row: MicrosoftCalendarConnection) =>
    run(row.id, async () => {
      const [res] = await syncMicrosoftCalendarNow(row.id);
      if (res?.status === 'busy') toast('A sync is already running — check again in a moment.', 'info');
      else if (res?.status === 'needs_reconnect' || res?.status === 'error') toast('Sync failed. Check the status and reconnect if needed.', 'error');
      else toast('Calendar synced.', 'success');
      await load();
      onChanged();
    }, 'Could not sync Microsoft 365.');

  const handleDisconnect = (row: MicrosoftCalendarConnection) =>
    run(row.id, async () => {
      await disconnectMicrosoftCalendar(row.id, deleteEvents);
      toast(deleteEvents ? 'Disconnected and Vireek events removed from Outlook.' : 'Disconnected. Existing Outlook events were left in place.', 'info');
      setConfirmId(null);
      setDeleteEvents(false);
      await load();
      onChanged();
    }, 'Could not disconnect Microsoft 365.');

  const handleConnectMine = () =>
    run('mine', () => startMicrosoftCalendarConnect('technician'), 'Could not connect Microsoft 365.');

  return (
    <div className="mt-4 rounded-xl border border-border bg-bg-primary p-4" aria-live="polite">
      <p className="text-xs leading-relaxed text-text-secondary">
        Two-way sync: busy time in Outlook blocks scheduling, and Vireek jobs appear in Outlook. Moving a scheduled job in
        Outlook reschedules it in Vireek.
      </p>

      {loading ? (
        <div className="mt-3 h-10 animate-pulse rounded-lg bg-bg-tertiary" />
      ) : loadError ? (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-danger-500/30 px-3 py-2 text-xs text-danger-500">
          <span className="flex items-center gap-1.5"><AlertTriangle size={14} /> Could not load calendar connections.</span>
          <button type="button" onClick={() => { setLoading(true); void load(); }} className="focus-ring font-medium underline">Retry</button>
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {rows.map((row) => {
            const d = describeConnection(row);
            const busy = busyId === row.id;
            return (
              <li key={row.id} className="rounded-lg border border-border bg-bg-secondary p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 truncate text-sm font-medium text-text-primary">
                      {row.scope === 'technician' && <User size={14} className="shrink-0 text-text-secondary" />}
                      {connectionTitle(row)}
                    </p>
                    <p className="truncate text-xs text-text-secondary">{row.ms_email ?? 'Microsoft account'} · {d.detail}</p>
                  </div>
                  <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${TONE_CLASS[d.tone]}`}>
                    {d.tone === 'ok' ? <Check size={12} /> : <AlertTriangle size={12} />} {d.label}
                  </span>
                </div>

                {confirmId === row.id ? (
                  <div className="mt-3 space-y-2 text-xs text-text-secondary">
                    <label className="flex items-start gap-2">
                      <input type="checkbox" checked={deleteEvents} onChange={(e) => setDeleteEvents(e.target.checked)} className="mt-0.5" />
                      Also remove the events Vireek created in this Outlook calendar
                    </label>
                    <div className="flex gap-2">
                      <button type="button" disabled={busy} onClick={() => handleDisconnect(row)} className="focus-ring flex items-center gap-1.5 rounded-lg bg-danger-500 px-3 py-1.5 font-medium text-white disabled:opacity-50">
                        {busy ? <Loader2 size={12} className="animate-spin" /> : <Link2Off size={12} />} Disconnect
                      </button>
                      <button type="button" onClick={() => { setConfirmId(null); setDeleteEvents(false); }} className="focus-ring rounded-lg border border-border px-3 py-1.5 font-medium">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {row.status === 'error' ? (
                      <button type="button" disabled={busyId !== null} onClick={() => run(row.id, () => startMicrosoftCalendarConnect(row.scope), 'Could not reconnect Microsoft 365.')} className="focus-ring flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/5 px-3 py-1.5 text-xs font-medium text-accent disabled:opacity-50">
                        <Link2 size={12} /> Reconnect
                      </button>
                    ) : (
                      <button type="button" disabled={busyId !== null} onClick={() => handleSync(row)} className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-50">
                        {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Sync now
                      </button>
                    )}
                    <button type="button" disabled={busyId !== null} onClick={() => setConfirmId(row.id)} className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:border-danger/40 hover:text-danger disabled:opacity-50">
                      <Link2Off size={12} /> Disconnect
                    </button>
                  </div>
                )}
              </li>
            );
          })}
          {rows.length === 0 && <li className="text-xs text-text-secondary">No Microsoft calendars connected yet.</li>}
        </ul>
      )}

      {myTechnicianId && !hasMine && !loading && !loadError && (
        <button type="button" onClick={handleConnectMine} disabled={busyId !== null} className="focus-ring mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-accent/30 bg-accent/5 px-4 py-2.5 text-sm font-medium text-accent hover:bg-accent/10 disabled:opacity-50">
          {busyId === 'mine' ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />} Connect my Outlook calendar
        </button>
      )}
    </div>
  );
}
