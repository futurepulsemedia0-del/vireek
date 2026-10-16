import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { useRealtimeSubscription, type RealtimeStatus } from '@/lib/realtime';
import { fetchLiveCalls, fetchScreenPop } from '@/lib/csrScreenPopApi';
import {
  applyCallChange,
  needsRepop,
  pruneEnded,
  sortQueue,
  toDeskCall,
  type DeskCall,
  type LiveCall,
  type ScreenPopData,
} from '@/lib/csrScreenPop';

const POLL_FALLBACK_MS = 15_000;
const PRUNE_EVERY_MS = 30_000;

export interface CsrDeskState {
  calls: DeskCall[];
  selectedId: string | null;
  selectedCall: DeskCall | null;
  select: (id: string | null) => void;
  dismiss: (id: string) => void;
  data: ScreenPopData | null;
  popLoading: boolean;
  popError: string | null;
  retryPop: () => void;
  queueLoading: boolean;
  queueError: string | null;
  realtime: RealtimeStatus;
  /** id of a call that arrived while another one was open (drives the "incoming" toast/title). */
  incomingId: string | null;
  clearIncoming: () => void;
}

/**
 * Live CSR desk state: the queue of in-progress calls (Supabase Realtime on
 * `calls`, with a polling fallback while the socket is down) plus the
 * screen-pop payload for the selected call.
 */
export function useCsrScreenPop(ownerId: string | undefined): CsrDeskState {
  const [calls, setCalls] = useState<DeskCall[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [data, setData] = useState<ScreenPopData | null>(null);
  const [popLoading, setPopLoading] = useState(false);
  const [popError, setPopError] = useState<string | null>(null);
  const [incomingId, setIncomingId] = useState<string | null>(null);

  const callsRef = useRef<DeskCall[]>([]);
  callsRef.current = calls;
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const popRequest = useRef(0);

  // ---- screen-pop lookup (race-safe: only the latest request may write state)
  const loadPop = useCallback(async (callId: string, quiet = false) => {
    const req = ++popRequest.current;
    if (!quiet) setPopLoading(true);
    setPopError(null);
    try {
      const result = await fetchScreenPop(callId);
      if (req === popRequest.current) setData(result);
    } catch (err) {
      if (req === popRequest.current) setPopError(err instanceof Error ? err.message : 'Could not load caller details');
    } finally {
      if (req === popRequest.current && !quiet) setPopLoading(false);
    }
  }, []);

  const select = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      setIncomingId((cur) => (cur === id ? null : cur));
      if (id) {
        setData(null);
        void loadPop(id);
      } else {
        popRequest.current++;
        setData(null);
        setPopLoading(false);
        setPopError(null);
      }
    },
    [loadPop]
  );

  // ---- initial queue + polling fallback
  const refreshQueue = useCallback(
    async (initial: boolean) => {
      if (!ownerId) return;
      try {
        const rows = await fetchLiveCalls(ownerId);
        setCalls((prev) => {
          const endedKept = prev.filter((c) => c.ended);
          const liveIds = new Set(rows.map((r) => r.id));
          // A call that vanished from the live set while we were disconnected has ended.
          const nowEnded = prev
            .filter((c) => !c.ended && !liveIds.has(c.id))
            .map((c) => toDeskCall(c, true, Date.now()));
          return sortQueue([...rows.map((r) => toDeskCall(r)), ...endedKept, ...nowEnded]);
        });
        setQueueError(null);
        if (initial && rows.length > 0 && !selectedRef.current) select(rows[0].id);
      } catch (err) {
        setQueueError(err instanceof Error ? err.message : 'Could not load live calls');
      } finally {
        if (initial) setQueueLoading(false);
      }
    },
    [ownerId, select]
  );

  useEffect(() => {
    if (!ownerId) return;
    setQueueLoading(true);
    void refreshQueue(true);
  }, [ownerId, refreshQueue]);

  // ---- realtime
  const onChange = useCallback(
    (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
      const row = (payload.new && Object.keys(payload.new).length ? payload.new : null) as LiveCall | null;
      const oldId = (payload.old as { id?: string } | undefined)?.id ?? null;
      const prev = row ? callsRef.current.find((c) => c.id === row.id) : undefined;
      const wasKnown = Boolean(prev);

      setCalls((list) => applyCallChange(list, { eventType: payload.eventType as 'INSERT' | 'UPDATE' | 'DELETE', row, oldId }, Date.now()));

      if (!row) return;
      const isNew = !wasKnown && row.duration_seconds == null;
      if (isNew) {
        if (!selectedRef.current) select(row.id);
        else setIncomingId(row.id);
      }
      if (row.id === selectedRef.current && needsRepop(prev, row)) void loadPop(row.id, true);
    },
    [loadPop, select]
  );

  const realtime = useRealtimeSubscription<Record<string, unknown>>({
    channelName: `csr-desk-calls-${ownerId ?? 'anon'}`,
    table: 'calls',
    event: '*',
    filter: ownerId ? `user_id=eq.${ownerId}` : undefined,
    onChange,
    enabled: Boolean(ownerId),
  });

  // Poll only while the socket is not healthy — never double-fetch when live.
  useEffect(() => {
    if (!ownerId || realtime === 'live') return;
    const t = setInterval(() => void refreshQueue(false), POLL_FALLBACK_MS);
    return () => clearInterval(t);
  }, [ownerId, realtime, refreshQueue]);

  // Drop finished calls after the wrap-up window.
  useEffect(() => {
    const t = setInterval(() => setCalls((list) => pruneEnded(list, Date.now())), PRUNE_EVERY_MS);
    return () => clearInterval(t);
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      setCalls((list) => list.filter((c) => c.id !== id));
      if (selectedRef.current === id) select(null);
    },
    [select]
  );

  const selectedCall = useMemo(() => calls.find((c) => c.id === selectedId) ?? null, [calls, selectedId]);

  return {
    calls,
    selectedId,
    selectedCall,
    select,
    dismiss,
    data,
    popLoading,
    popError,
    retryPop: () => selectedRef.current && void loadPop(selectedRef.current),
    queueLoading,
    queueError,
    realtime,
    incomingId,
    clearIncoming: () => setIncomingId(null),
  };
}
