import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Radio, Lock, PhoneCall, PhoneForwarded, PhoneIncoming, History, UserRound } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { LiveIndicator } from '@/components/LiveIndicator';
import { Button } from '@/components/ui/Button';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';
import { LiveCallCard, LiveCallBadges } from '@/components/live-calls/LiveCallCard';
import { LiveTranscript } from '@/components/live-calls/LiveTranscript';
import { useRealtimeSubscription } from '@/lib/realtime';
import { announce } from '@/lib/a11y/announcer';
import {
  HandoffError,
  fetchLines,
  fetchLiveCalls,
  formatElapsed,
  mergeLines,
  partitionLiveCalls,
  removeById,
  requestHandoff,
  upsertById,
  type HandoffMode,
  type LiveCallLine,
  type LiveCallRow,
} from '@/lib/liveCalls';

export function LiveCallsPage() {
  const navigate = useNavigate();
  const { profile, teamMember, isOwner, permissions } = useAuth();
  const { toast } = useToast();

  const canAccess = isOwner || permissions.can_manage_numbers;
  // For a team member every row is keyed by the OWNER's id, not their own.
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;

  const [rows, setRows] = useState<LiveCallRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lines, setLines] = useState<LiveCallLine[]>([]);
  const [linesLoading, setLinesLoading] = useState(false);
  const [linesError, setLinesError] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [confirmMode, setConfirmMode] = useState<HandoffMode | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const linesRequest = useRef(0);

  // ---------- data ----------
  const loadRows = useCallback(
    async (silent: boolean) => {
      if (!canAccess) return;
      if (!silent) setLoading(true);
      setLoadError(false);
      try {
        setRows(await fetchLiveCalls());
      } catch {
        if (!silent) setLoadError(true);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [canAccess],
  );

  useEffect(() => {
    void loadRows(false);
  }, [loadRows]);

  const loadLines = useCallback(async (liveCallId: string) => {
    const id = ++linesRequest.current;
    setLinesLoading(true);
    setLinesError(false);
    try {
      const fetched = await fetchLines(liveCallId);
      if (id !== linesRequest.current) return;
      // Merge, don't replace: realtime lines may have arrived while we fetched.
      setLines((prev) => mergeLines(prev, fetched));
    } catch {
      if (id === linesRequest.current) setLinesError(true);
    } finally {
      if (id === linesRequest.current) setLinesLoading(false);
    }
  }, []);

  useEffect(() => {
    linesRequest.current += 1;
    setLines([]);
    setLinesError(false);
    if (!selectedId) {
      setLinesLoading(false);
      return;
    }
    void loadLines(selectedId);
  }, [selectedId, loadLines]);

  // ---------- realtime ----------
  const callsStatus = useRealtimeSubscription<LiveCallRow>({
    channelName: `live-calls-${accountOwnerId ?? 'anon'}`,
    table: 'live_calls',
    event: '*',
    filter: accountOwnerId ? `user_id=eq.${accountOwnerId}` : undefined,
    enabled: !!accountOwnerId && canAccess,
    onChange: (payload) => {
      if (payload.eventType === 'DELETE') {
        const old = payload.old as Partial<LiveCallRow>;
        if (old.id) setRows((prev) => removeById(prev, old.id as string));
        return;
      }
      const row = payload.new as LiveCallRow;
      setRows((prev) => upsertById(prev, row));
      if (payload.eventType === 'INSERT' && row.status !== 'ended') {
        announce(`New call from ${row.caller_name || row.caller_phone || 'an unknown caller'}.`, 'assertive');
      }
    },
  });

  useRealtimeSubscription<LiveCallLine>({
    channelName: `live-call-lines-${accountOwnerId ?? 'anon'}`,
    table: 'live_call_lines',
    event: 'INSERT',
    filter: accountOwnerId ? `user_id=eq.${accountOwnerId}` : undefined,
    enabled: !!accountOwnerId && canAccess,
    onChange: (payload) => {
      const line = payload.new as LiveCallLine;
      if (line.live_call_id === selectedId) setLines((prev) => mergeLines(prev, [line]));
    },
  });

  // Anything missed while the socket was down is re-read once it is back.
  const prevStatus = useRef(callsStatus);
  useEffect(() => {
    if (prevStatus.current === 'reconnecting' && callsStatus === 'live') {
      void loadRows(true);
      if (selectedId) void loadLines(selectedId);
    }
    prevStatus.current = callsStatus;
  }, [callsStatus, loadRows, loadLines, selectedId]);

  // ---------- derived ----------
  const { active, recent } = useMemo(() => partitionLiveCalls(rows, nowMs), [rows, nowMs]);
  const selected = useMemo(() => rows.find((r) => r.id === selectedId) ?? null, [rows, selectedId]);
  const hasActive = active.length > 0 || selected?.status === 'in_progress';

  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasActive]);

  // The selected call was deleted by retention -> leave the detail view.
  useEffect(() => {
    if (selectedId && !loading && !rows.some((r) => r.id === selectedId)) setSelectedId(null);
  }, [rows, selectedId, loading]);

  // ---------- hand-off ----------
  const handleHandoff = async (mode: HandoffMode) => {
    if (!selected) return;
    setHandoffBusy(true);
    try {
      const res = await requestHandoff(selected.vapi_call_id, mode);
      // Optimistic: realtime will confirm, but do not depend on it.
      setRows((prev) =>
        prev.map((r) => (r.id === selected.id ? { ...r, handoff_status: 'requested', handoff_mode: mode, handoff_error: null } : r)),
      );
      toast(mode === 'take_over' ? `Calling you at ${res.destinationHint} to connect you.` : `Transferring to your team at ${res.destinationHint}.`, 'success');
    } catch (e) {
      toast(e instanceof HandoffError ? e.message : 'Could not transfer the call. Please try again.', 'error');
    } finally {
      setHandoffBusy(false);
      setConfirmMode(null);
    }
  };

  // ============================================================
  // RENDER
  // ============================================================

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Live Calls">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Live Calls shows callers in real time and lets you step in. Ask your account owner to grant you the "Manage Numbers" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  const callLive = selected?.status === 'in_progress';
  const handoffPending = selected?.handoff_status === 'requested';

  return (
    <DashboardLayout activeLabel="Live Calls">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
            aria-label="Back to dashboard"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <Radio size={16} />
              </span>
              <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Live Calls</h1>
              <LiveIndicator status={callsStatus} />
            </div>
            <p className="mt-1 text-sm text-text-secondary">
              Watch calls as they happen and step in when a caller needs a person
              {!loading && !loadError ? ` · ${active.length} in progress` : ''}
            </p>
          </div>
        </div>
      </div>

      {callsStatus === 'reconnecting' && (
        <div role="status" className="mb-4 rounded-xl border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-text-primary">
          Connection lost — reconnecting. The board may be out of date until it is back.
        </div>
      )}

      {loading ? (
        <div className="grid gap-4 lg:grid-cols-[400px_1fr]">
          <SkeletonCardList count={3} rows={2} />
          <div className="hidden lg:block">
            <SkeletonCardList count={1} rows={6} />
          </div>
        </div>
      ) : loadError ? (
        <div role="alert" className="flex flex-col items-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-16 text-center">
          <p className="text-base font-semibold text-text-primary">Couldn't load live calls</p>
          <p className="mt-1 text-sm text-text-secondary">Check your connection and try again.</p>
          <Button type="button" variant="secondary" size="sm" className="mt-4" onClick={() => void loadRows(false)}>
            Try again
          </Button>
        </div>
      ) : (
        <FadeIn>
          <div className="grid gap-4 lg:grid-cols-[400px_1fr]">
            {/* ---------- list ---------- */}
            <div className={`${selected ? 'hidden lg:block' : ''} min-w-0 space-y-6`}>
              {active.length === 0 ? (
                <EmptyState
                  icon={PhoneIncoming}
                  title="No calls in progress"
                  description="When someone calls, they appear here instantly. Calls that just ended stay for 30 minutes."
                />
              ) : (
                <ul className="space-y-3" aria-label="Calls in progress">
                  {active.map((c) => (
                    <li key={c.id}>
                      <LiveCallCard call={c} nowMs={nowMs} selected={c.id === selectedId} onSelect={setSelectedId} />
                    </li>
                  ))}
                </ul>
              )}

              {recent.length > 0 && (
                <section>
                  <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-secondary">
                    <History size={14} />
                    Just ended
                  </h2>
                  <ul className="space-y-3">
                    {recent.map((c) => (
                      <li key={c.id}>
                        <LiveCallCard call={c} nowMs={nowMs} selected={c.id === selectedId} onSelect={setSelectedId} />
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <details className="rounded-xl border border-border bg-bg-secondary px-4 py-3 text-sm text-text-secondary">
                <summary className="cursor-pointer font-medium text-text-primary">Board empty during a real call?</summary>
                <p className="mt-2 leading-relaxed">
                  The board is fed by your Vapi assistant's server messages. In Vapi, make sure the assistant sends{' '}
                  <code className="rounded bg-bg-tertiary px-1 py-0.5 text-xs">status-update</code>,{' '}
                  <code className="rounded bg-bg-tertiary px-1 py-0.5 text-xs">transcript</code> and{' '}
                  <code className="rounded bg-bg-tertiary px-1 py-0.5 text-xs">end-of-call-report</code> to your webhook.
                </p>
              </details>
            </div>

            {/* ---------- detail ---------- */}
            <section className={`${selected ? '' : 'hidden lg:flex'} min-w-0 flex-col rounded-2xl border border-border bg-bg-secondary`}>
              {!selected ? (
                <div className="flex flex-1 flex-col items-center justify-center px-6 py-20 text-center">
                  <PhoneCall size={26} className="text-text-secondary" />
                  <p className="mt-3 text-sm text-text-secondary">Select a call to follow the conversation.</p>
                </div>
              ) : (
                <>
                  <div className="border-b border-border p-4">
                    <button
                      type="button"
                      onClick={() => setSelectedId(null)}
                      className="focus-ring mb-3 inline-flex items-center gap-1.5 rounded-lg text-sm text-text-secondary hover:text-text-primary lg:hidden"
                    >
                      <ArrowLeft size={15} />
                      All calls
                    </button>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <h2 className="truncate text-lg font-semibold text-text-primary">
                          {selected.caller_name || selected.caller_phone || 'Unknown caller'}
                        </h2>
                        <p className="text-sm text-text-secondary">
                          {selected.caller_phone && selected.caller_name ? `${selected.caller_phone} · ` : ''}
                          <span className="font-mono tabular-nums">
                            {formatElapsed((selected.ended_at ? Date.parse(selected.ended_at) : nowMs) - Date.parse(selected.started_at))}
                          </span>
                          {callLive ? ' · in progress' : selected.status === 'ringing' ? ' · ringing' : ' · ended'}
                        </p>
                        <div className="mt-2">
                          <LiveCallBadges call={selected} />
                        </div>
                      </div>
                      {callLive && (
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <Button type="button" size="sm" onClick={() => setConfirmMode('take_over')} disabled={handoffPending || handoffBusy}>
                            <UserRound size={15} />
                            Take over
                          </Button>
                          <Button type="button" variant="secondary" size="sm" onClick={() => setConfirmMode('transfer')} disabled={handoffPending || handoffBusy}>
                            <PhoneForwarded size={15} />
                            Transfer to team
                          </Button>
                        </div>
                      )}
                    </div>

                    {handoffPending && (
                      <p role="status" className="mt-3 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2 text-sm text-text-primary">
                        {selected.handoff_mode === 'take_over' ? 'Take-over' : 'Transfer'} requested
                        {selected.handoff_at ? ` at ${new Date(selected.handoff_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}. The caller is being connected.
                      </p>
                    )}
                    {selected.handoff_status === 'failed' && (
                      <p role="alert" className="mt-3 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-text-primary">
                        The last hand-off attempt failed{selected.handoff_error ? `: ${selected.handoff_error}` : '.'} You can try again.
                      </p>
                    )}
                    {selected.status === 'ended' && (
                      <p className="mt-3 text-sm text-text-secondary">
                        This call has ended.{' '}
                        <button type="button" onClick={() => navigate('/dashboard/calls')} className="focus-ring rounded font-medium text-accent hover:underline">
                          Open it in Call History
                        </button>{' '}
                        for the recording and summary.
                      </p>
                    )}
                  </div>

                  <LiveTranscript
                    lines={lines}
                    loading={linesLoading && lines.length === 0}
                    error={linesError}
                    onRetry={() => selectedId && void loadLines(selectedId)}
                    live={selected.status !== 'ended'}
                  />
                </>
              )}
            </section>
          </div>
        </FadeIn>
      )}

      <ConfirmDialog
        open={confirmMode !== null}
        title={confirmMode === 'take_over' ? 'Take over this call?' : 'Transfer this call to your team?'}
        description={
          confirmMode === 'take_over'
            ? 'The AI tells the caller it is connecting them, then the call is connected to the mobile number on your account. Make sure your phone is ready to answer.'
            : "The AI tells the caller it is connecting them, then the call goes to your team's transfer number from your business settings."
        }
        confirmLabel={confirmMode === 'take_over' ? 'Take over' : 'Transfer call'}
        onCancel={() => setConfirmMode(null)}
        onConfirm={() => (confirmMode ? handleHandoff(confirmMode) : undefined)}
      />
    </DashboardLayout>
  );
}
