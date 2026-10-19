import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRealtimeSubscription } from '@/lib/realtime';
import type { RealtimeStatus } from '@/lib/realtime';
import {
  buildThreads,
  countOpenThreads,
  describeCommentError,
  isUuid,
  removeComment,
  upsertComment,
} from '@/lib/comments';
import type { CommentEntityType, CommentRow, CommentThread, MentionCandidate } from '@/lib/comments';
import {
  deleteComment,
  editComment,
  fetchComments,
  fetchMentionCandidates,
  postComment,
  setThreadResolved,
} from '@/lib/commentsApi';

export type CommentsStatus = 'loading' | 'ready' | 'error';

export type ActionResult = { ok: true } | { ok: false; error: string };

interface Options {
  entityType: CommentEntityType;
  entityId: string | null | undefined;
  enabled?: boolean;
}

export interface EntityComments {
  threads: CommentThread[];
  openCount: number;
  total: number;
  status: CommentsStatus;
  live: RealtimeStatus;
  reload: () => Promise<void>;
  post: (body: string, parentId?: string | null) => Promise<ActionResult>;
  edit: (id: string, body: string) => Promise<ActionResult>;
  remove: (id: string) => Promise<ActionResult>;
  setResolved: (rootId: string, resolved: boolean) => Promise<ActionResult>;
}

/**
 * Loads the comments of one record, keeps them live through Supabase Realtime and
 * exposes the write actions. Realtime applies the table's RLS, so a viewer only
 * ever receives rows they may read.
 */
export function useEntityComments({ entityType, entityId, enabled = true }: Options): EntityComments {
  const valid = enabled && !!entityId && isUuid(entityId);
  const scope = useMemo(() => ({ type: entityType, id: entityId ?? '' }), [entityType, entityId]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const [rows, setRows] = useState<CommentRow[]>([]);
  const [status, setStatus] = useState<CommentsStatus>('loading');
  const requestRef = useRef(0);
  // One channel per mounted panel: two panels for the same record must not share a channel name.
  const instance = useId().replace(/[^a-zA-Z0-9]/g, '');

  const load = useCallback(
    async (silent = false) => {
      if (!valid) return;
      const request = ++requestRef.current;
      if (!silent) setStatus('loading');
      try {
        const data = await fetchComments(scopeRef.current.type, scopeRef.current.id);
        if (request !== requestRef.current) return;
        setRows(data);
        setStatus('ready');
      } catch {
        if (request !== requestRef.current) return;
        // A silent refresh failing must not wipe a list the person is reading.
        if (!silent) setStatus('error');
      }
    },
    [valid],
  );

  useEffect(() => {
    setRows([]);
    if (!valid) return;
    void load(false);
    const counter = requestRef;
    return () => {
      counter.current++; // drop in-flight responses for the previous record
    };
  }, [valid, entityType, entityId, load]);

  const live = useRealtimeSubscription<CommentRow>({
    channelName: `entity-comments-${entityType}-${entityId ?? 'none'}-${instance}`,
    table: 'entity_comments',
    event: '*',
    filter: entityId ? `entity_id=eq.${entityId}` : undefined,
    enabled: valid,
    onChange: (payload) => {
      if (payload.eventType === 'DELETE') {
        const old = payload.old as Partial<CommentRow>;
        if (old.id) setRows((prev) => removeComment(prev, old.id as string));
        return;
      }
      const next = payload.new as CommentRow;
      if (next?.id) setRows((prev) => upsertComment(prev, next, scopeRef.current));
    },
  });

  // Anything missed while the socket was down is picked up once it is back.
  const wasDown = useRef(false);
  useEffect(() => {
    if (live === 'reconnecting') wasDown.current = true;
    if (live === 'live' && wasDown.current) {
      wasDown.current = false;
      void load(true);
    }
  }, [live, load]);

  const apply = useCallback((row: CommentRow) => {
    setRows((prev) => upsertComment(prev, row, scopeRef.current));
  }, []);

  const post = useCallback<EntityComments['post']>(
    async (body, parentId = null) => {
      if (!valid) return { ok: false, error: 'Comments are not available here.' };
      try {
        apply(await postComment({ type: scopeRef.current.type, entityId: scopeRef.current.id, body, parentId }));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: describeCommentError(e, 'Could not post your comment. Please try again.') };
      }
    },
    [valid, apply],
  );

  const edit = useCallback<EntityComments['edit']>(
    async (id, body) => {
      try {
        apply(await editComment(id, body));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: describeCommentError(e, 'Could not save your changes. Please try again.') };
      }
    },
    [apply],
  );

  // Optimistic: flip locally, roll back when the server says no.
  const mutateOptimistic = useCallback(
    async (id: string, patch: Partial<CommentRow>, run: () => Promise<CommentRow>, fallback: string): Promise<ActionResult> => {
      let before: CommentRow | undefined;
      setRows((prev) =>
        prev.map((r) => {
          if (r.id !== id) return r;
          before = r;
          return { ...r, ...patch };
        }),
      );
      try {
        apply(await run());
        return { ok: true };
      } catch (e) {
        const snapshot = before;
        if (snapshot) setRows((prev) => prev.map((r) => (r.id === id ? snapshot : r)));
        return { ok: false, error: describeCommentError(e, fallback) };
      }
    },
    [apply],
  );

  const remove = useCallback<EntityComments['remove']>(
    (id) =>
      mutateOptimistic(
        id,
        { deleted_at: new Date().toISOString(), body: '', mentions: [] },
        () => deleteComment(id),
        'Could not delete that comment. Please try again.',
      ),
    [mutateOptimistic],
  );

  const setResolved = useCallback<EntityComments['setResolved']>(
    (rootId, resolved) =>
      mutateOptimistic(
        rootId,
        { resolved_at: resolved ? new Date().toISOString() : null, resolved_by_name: null },
        () => setThreadResolved(rootId, resolved),
        resolved ? 'Could not resolve this thread. Please try again.' : 'Could not reopen this thread. Please try again.',
      ),
    [mutateOptimistic],
  );

  const threads = useMemo(() => buildThreads(rows), [rows]);

  return {
    threads,
    openCount: countOpenThreads(threads),
    total: rows.filter((r) => !r.deleted_at).length,
    status,
    live,
    reload: () => load(false),
    post,
    edit,
    remove,
    setResolved,
  };
}

/** Loads the @mention list once per record. A failure is non-fatal: comments still work, the picker is just empty. */
export function useMentionCandidates(
  entityType: CommentEntityType,
  entityId: string | null | undefined,
  enabled = true,
): { candidates: MentionCandidate[]; loading: boolean; failed: boolean } {
  const [state, setState] = useState<{ candidates: MentionCandidate[]; loading: boolean; failed: boolean }>({
    candidates: [],
    loading: true,
    failed: false,
  });
  const valid = enabled && !!entityId && isUuid(entityId);

  useEffect(() => {
    if (!valid || !entityId) {
      setState({ candidates: [], loading: false, failed: false });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, failed: false }));
    fetchMentionCandidates(entityType, entityId)
      .then((candidates) => {
        if (!cancelled) setState({ candidates, loading: false, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ candidates: [], loading: false, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [valid, entityType, entityId]);

  return state;
}
