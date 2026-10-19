import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, ChevronDown, ChevronUp, MessageSquare, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { LiveIndicator } from '@/components/LiveIndicator';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { CommentBody } from '@/components/comments/CommentBody';
import { MentionComposer } from '@/components/comments/MentionComposer';
import { useEntityComments, useMentionCandidates } from '@/hooks/useEntityComments';
import {
  EMPTY_DRAFT,
  draftFromBody,
  filterThreads,
  relativeTime,
  serializeDraft,
  validateDraft,
} from '@/lib/comments';
import type { CommentEntityType, CommentRow, CommentThread, Draft, MentionCandidate, ThreadFilter } from '@/lib/comments';

interface Props {
  entityType: CommentEntityType;
  entityId: string;
  /** Only used for accessible names, e.g. "Comments on Smith HVAC". */
  entityLabel?: string;
  /** Hide the composer (read-only). The database enforces access either way. */
  canComment?: boolean;
  className?: string;
}

const FILTERS: { id: ThreadFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'resolved', label: 'Resolved' },
];

function fullDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function Avatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-semibold text-accent"
    >
      {(name.trim().slice(0, 1) || '?').toUpperCase()}
    </span>
  );
}

export function CommentsPanel({ entityType, entityId, entityLabel, canComment = true, className = '' }: Props) {
  const { user, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const meId = user?.id ?? null;
  const isManager = isOwner || permissions.can_view_all_jobs;

  const { threads, openCount, total, status, live, reload, post, edit, remove, setResolved } = useEntityComments({
    entityType,
    entityId,
  });
  const { candidates } = useMentionCandidates(entityType, entityId, canComment);

  const [filter, setFilter] = useState<ThreadFilter>('all');
  const [newDraft, setNewDraft] = useState<Draft>(EMPTY_DRAFT);
  const [newError, setNewError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // 'new' | 'reply:<id>' | 'edit:<id>'
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState<Draft>(EMPTY_DRAFT);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; draft: Draft } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // resolved threads opened by hand
  const [confirmDelete, setConfirmDelete] = useState<CommentRow | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  // ---- deep link: ?comment=<id> (from a notification) ----
  const [params] = useSearchParams();
  const focusId = params.get('comment');
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (!focusId || status !== 'ready' || focused.current === focusId) return;
    const thread = threads.find((t) => t.root.id === focusId || t.replies.some((r) => r.id === focusId));
    if (!thread) return;
    focused.current = focusId;
    if (thread.resolved) setExpanded((prev) => new Set(prev).add(thread.root.id));
    setFilter('all');
    setHighlightId(focusId);
    const frame = requestAnimationFrame(() => {
      document.getElementById(`comment-${focusId}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    });
    const timer = window.setTimeout(() => setHighlightId(null), 4000);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [focusId, status, threads]);

  const visible = useMemo(() => filterThreads(threads, filter), [threads, filter]);
  const name = entityLabel ? `Comments on ${entityLabel}` : 'Comments';

  // ---- actions ----
  const submitNew = async () => {
    const problem = validateDraft(newDraft);
    if (problem) {
      setNewError(problem);
      return;
    }
    setBusy('new');
    setNewError(null);
    const res = await post(serializeDraft(newDraft));
    setBusy(null);
    if (res.ok) {
      setNewDraft(EMPTY_DRAFT);
      setFilter((f) => (f === 'resolved' ? 'all' : f));
    } else {
      setNewError(res.error);
    }
  };

  const submitReply = async (rootId: string) => {
    const problem = validateDraft(replyDraft);
    if (problem) {
      setReplyError(problem);
      return;
    }
    setBusy(`reply:${rootId}`);
    setReplyError(null);
    const res = await post(serializeDraft(replyDraft), rootId);
    setBusy(null);
    if (res.ok) {
      setReplyTo(null);
      setReplyDraft(EMPTY_DRAFT);
    } else {
      setReplyError(res.error);
    }
  };

  const submitEdit = async () => {
    if (!editing) return;
    const problem = validateDraft(editing.draft);
    if (problem) {
      setEditError(problem);
      return;
    }
    setBusy(`edit:${editing.id}`);
    setEditError(null);
    const res = await edit(editing.id, serializeDraft(editing.draft));
    setBusy(null);
    if (res.ok) setEditing(null);
    else setEditError(res.error);
  };

  const toggleResolved = async (thread: CommentThread) => {
    const res = await setResolved(thread.root.id, !thread.resolved);
    if (!res.ok) toast(res.error, 'error');
  };

  const confirmRemove = async () => {
    const target = confirmDelete;
    setConfirmDelete(null);
    if (!target) return;
    const res = await remove(target.id);
    if (!res.ok) toast(res.error, 'error');
  };

  const startReply = (rootId: string) => {
    setReplyTo(rootId);
    setReplyDraft(EMPTY_DRAFT);
    setReplyError(null);
  };

  // ---- one comment ----
  const renderComment = (c: CommentRow, thread: CommentThread, isRoot: boolean) => {
    const mine = !!meId && c.author_id === meId;
    const canDelete = mine || isManager;
    const isEditing = editing?.id === c.id;
    const highlighted = highlightId === c.id;

    if (c.deleted_at) {
      return (
        <article id={`comment-${c.id}`} key={c.id} className="flex items-start gap-3">
          <Avatar name="?" />
          <p className="pt-1.5 text-sm italic text-text-secondary">This comment was deleted.</p>
        </article>
      );
    }

    return (
      <article
        id={`comment-${c.id}`}
        key={c.id}
        aria-label={`${c.author_name}, ${relativeTime(c.created_at)}`}
        className={`flex items-start gap-3 rounded-xl transition-colors ${highlighted ? 'bg-accent/10 ring-2 ring-accent/40' : ''}`}
      >
        <Avatar name={c.author_name} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm font-semibold text-text-primary">
              {c.author_name}
              {mine && <span className="ml-1.5 text-[11px] font-medium text-text-secondary">(you)</span>}
            </span>
            <time dateTime={c.created_at} title={fullDate(c.created_at)} className="text-xs text-text-secondary">
              {relativeTime(c.created_at)}
            </time>
            {c.edited_at && (
              <span className="text-xs text-text-secondary" title={`Edited ${fullDate(c.edited_at)}`}>
                · edited
              </span>
            )}
          </div>

          {isEditing && editing ? (
            <div className="mt-2">
              <MentionComposer
                draft={editing.draft}
                onChange={(draft) => setEditing({ id: editing.id, draft })}
                onSubmit={() => void submitEdit()}
                onCancel={() => {
                  setEditing(null);
                  setEditError(null);
                }}
                candidates={candidates as MentionCandidate[]}
                currentUserId={meId}
                submitting={busy === `edit:${c.id}`}
                label="Edit comment"
                submitLabel="Save"
                autoFocus
                error={editError}
              />
            </div>
          ) : (
            <>
              <div className="mt-1">
                <CommentBody body={c.body} mentions={c.mentions} currentUserId={meId} />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {isRoot && !thread.resolved && canComment && replyTo !== c.id && (
                  <button
                    type="button"
                    onClick={() => startReply(c.id)}
                    className="focus-ring rounded-md px-1.5 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                  >
                    Reply
                  </button>
                )}
                {mine && canComment && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditing({ id: c.id, draft: draftFromBody(c.body) });
                      setEditError(null);
                    }}
                    aria-label="Edit comment"
                    className="focus-ring flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                  >
                    <Pencil size={11} aria-hidden="true" /> Edit
                  </button>
                )}
                {canDelete && (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(c)}
                    aria-label="Delete comment"
                    className="focus-ring flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-danger"
                  >
                    <Trash2 size={11} aria-hidden="true" /> Delete
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </article>
    );
  };

  // ---- one thread ----
  const renderThread = (thread: CommentThread) => {
    const { root, replies } = thread;
    const isOpenResolved = expanded.has(root.id);
    const collapsed = thread.resolved && !isOpenResolved;

    return (
      <li
        key={root.id}
        className={`rounded-xl border bg-bg-primary p-3 sm:p-4 ${thread.resolved ? 'border-success-500/25' : 'border-border'}`}
      >
        {thread.resolved && (
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-xs font-medium text-success-500">
              <CheckCircle2 size={13} aria-hidden="true" />
              Resolved{root.resolved_by_name ? ` by ${root.resolved_by_name}` : ''}
              {root.resolved_at ? ` · ${relativeTime(root.resolved_at)}` : ''}
            </p>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(root.id)) next.delete(root.id);
                    else next.add(root.id);
                    return next;
                  })
                }
                aria-expanded={!collapsed}
                className="focus-ring flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
              >
                {collapsed ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronUp size={12} aria-hidden="true" />}
                {collapsed ? `Show thread${replies.length ? ` (${replies.length + 1})` : ''}` : 'Hide thread'}
              </button>
              {canComment && (
                <button
                  type="button"
                  onClick={() => void toggleResolved(thread)}
                  className="focus-ring flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                >
                  <RotateCcw size={12} aria-hidden="true" /> Reopen
                </button>
              )}
            </div>
          </div>
        )}

        {collapsed ? (
          <p className="truncate text-sm text-text-secondary">{root.deleted_at ? 'This comment was deleted.' : `${root.author_name}: ${root.body.replace(/@\[([^\]]*)\]\(user:[^)]*\)/g, '@$1')}`}</p>
        ) : (
          <div className="space-y-3">
            {renderComment(root, thread, true)}
            {replies.length > 0 && (
              <div className="ml-4 space-y-3 border-l border-border pl-4 sm:ml-5 sm:pl-5">
                {replies.map((r) => renderComment(r, thread, false))}
              </div>
            )}

            {!thread.resolved && (
              <div className="ml-4 sm:ml-5">
                {replyTo === root.id ? (
                  <MentionComposer
                    draft={replyDraft}
                    onChange={setReplyDraft}
                    onSubmit={() => void submitReply(root.id)}
                    onCancel={() => {
                      setReplyTo(null);
                      setReplyError(null);
                    }}
                    candidates={candidates}
                    currentUserId={meId}
                    submitting={busy === `reply:${root.id}`}
                    label="Reply"
                    placeholder="Write a reply…"
                    submitLabel="Reply"
                    autoFocus
                    error={replyError}
                  />
                ) : (
                  canComment && (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void toggleResolved(thread)}
                        className="focus-ring flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-success-500"
                      >
                        <CheckCircle2 size={12} aria-hidden="true" /> Resolve
                      </button>
                    </div>
                  )
                )}
              </div>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <section
      id="comments"
      aria-label={name}
      className={`rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5 ${className}`}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <MessageSquare size={15} className="text-text-secondary" aria-hidden="true" />
          Comments
          {total > 0 && (
            <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-semibold text-text-secondary">
              {openCount > 0 ? `${openCount} open` : 'All resolved'}
            </span>
          )}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <LiveIndicator status={live} />
          {threads.length > 0 && (
            <div role="group" aria-label="Filter threads" className="flex items-center gap-0.5 rounded-lg bg-bg-tertiary p-0.5">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFilter(f.id)}
                  aria-pressed={filter === f.id}
                  className={`focus-ring rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    filter === f.id ? 'bg-bg-secondary text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {status === 'loading' ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading comments">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      ) : status === 'error' ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
          <span>Could not load comments.</span>
          <Button variant="ghost" size="sm" onClick={() => void reload()}>
            Retry
          </Button>
        </div>
      ) : threads.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="No comments yet"
          description={canComment ? 'Start the conversation — type @ to notify a teammate.' : 'Comments from your team will show up here.'}
          className="py-6"
        />
      ) : visible.length === 0 ? (
        <p className="py-4 text-center text-sm text-text-secondary">
          {filter === 'open' ? 'Every thread is resolved.' : 'No threads are resolved so far.'}
        </p>
      ) : (
        <ol className="space-y-3" aria-label="Comment threads">
          {visible.map(renderThread)}
        </ol>
      )}

      {canComment && status !== 'error' && (
        <div className="mt-4 border-t border-border pt-4">
          <MentionComposer
            draft={newDraft}
            onChange={setNewDraft}
            onSubmit={() => void submitNew()}
            candidates={candidates}
            currentUserId={meId}
            submitting={busy === 'new'}
            label="New comment"
            error={newError}
          />
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete this comment?"
        description="It will be removed for everyone. Replies in the thread stay."
        confirmLabel="Delete"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => void confirmRemove()}
      />
    </section>
  );
}
