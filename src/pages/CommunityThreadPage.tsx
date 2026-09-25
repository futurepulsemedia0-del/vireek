/**
 * Community thread detail — /dashboard/community/:threadId
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { CheckCircle2, ThumbsUp } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  acceptCommunityReply,
  createCommunityReply,
  fetchCommunityReplies,
  fetchCommunityThread,
  fetchMyCommunityVotes,
  incrementCommunityThreadViews,
  toggleCommunityVote,
  type CommunityReply,
  type CommunityThread,
} from '@/lib/community';

function VoteButton({ active, count, onToggle }: { active: boolean; count: number; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`focus-ring flex flex-col items-center gap-1 rounded-xl border px-3 py-2 text-xs font-semibold ${
        active ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-accent'
      }`}
    >
      <ThumbsUp size={14} />
      {count}
    </button>
  );
}

function ReplyCard({
  reply,
  isThreadAuthor,
  voted,
  onVote,
  onAccept,
}: {
  reply: CommunityReply;
  isThreadAuthor: boolean;
  voted: boolean;
  onVote: () => void;
  onAccept: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex gap-3 rounded-2xl border p-4 ${reply.is_accepted ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-border bg-bg-secondary'}`}
    >
      <VoteButton active={voted} count={reply.upvote_count} onToggle={onVote} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-medium text-text-secondary">{reply.author_name}</p>
          {reply.is_accepted && (
            <span className="flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-600">
              <CheckCircle2 size={11} /> Accepted answer
            </span>
          )}
        </div>
        <p className="mt-2 whitespace-pre-wrap text-sm text-text-primary">{reply.body}</p>
        {isThreadAuthor && !reply.is_accepted && (
          <button type="button" onClick={onAccept} className="focus-ring mt-2 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-text-secondary hover:text-accent">
            Mark as accepted answer
          </button>
        )}
      </div>
    </motion.div>
  );
}

export function CommunityThreadPage() {
  const { threadId } = useParams<{ threadId: string }>();
  const { user, profile } = useAuth();
  const { toast } = useToast();

  const [thread, setThread] = useState<CommunityThread | null>(null);
  const [replies, setReplies] = useState<CommunityReply[]>([]);
  const [votedIds, setVotedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [replyBody, setReplyBody] = useState('');
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    if (!threadId || !user) return;
    setLoading(true);
    try {
      const [t, r] = await Promise.all([fetchCommunityThread(threadId), fetchCommunityReplies(threadId)]);
      setThread(t);
      setReplies(r);
      const ids = [threadId, ...r.map((x) => x.id)];
      setVotedIds(await fetchMyCommunityVotes('thread', [threadId]).then(async (tv) => {
        const rv = await fetchMyCommunityVotes('reply', r.map((x) => x.id));
        return new Set([...tv, ...rv]);
      }));
      void ids; // ids only used to build the two vote lookups above
      incrementCommunityThreadViews(threadId);
    } catch {
      toast('Could not load this thread', 'error');
    }
    setLoading(false);
  }, [threadId, user, toast]);

  useEffect(() => { void load(); }, [load]);

  const handleVote = async (targetType: 'thread' | 'reply', targetId: string) => {
    try {
      const nowVoted = await toggleCommunityVote(targetType, targetId);
      setVotedIds((prev) => {
        const next = new Set(prev);
        if (nowVoted) next.add(targetId); else next.delete(targetId);
        return next;
      });
      if (targetType === 'thread') {
        setThread((t) => (t ? { ...t, upvote_count: t.upvote_count + (nowVoted ? 1 : -1) } : t));
      } else {
        setReplies((prev) => prev.map((r) => (r.id === targetId ? { ...r, upvote_count: r.upvote_count + (nowVoted ? 1 : -1) } : r)));
      }
    } catch {
      toast('Could not register your vote', 'error');
    }
  };

  const handleAccept = async (replyId: string) => {
    try {
      await acceptCommunityReply(replyId);
      setReplies((prev) => prev.map((r) => ({ ...r, is_accepted: r.id === replyId })));
      setThread((t) => (t ? { ...t, status: 'answered', accepted_reply_id: replyId } : t));
      toast('Marked as the accepted answer', 'success');
    } catch {
      toast('Only the thread author can accept an answer', 'error');
    }
  };

  const handleReply = async () => {
    if (!threadId || replyBody.trim().length < 1) return;
    setPosting(true);
    try {
      const authorName = profile?.full_name || profile?.company_name || 'A Vireek customer';
      const reply = await createCommunityReply(threadId, replyBody.trim(), authorName);
      setReplies((prev) => [...prev, reply]);
      setThread((t) => (t ? { ...t, reply_count: t.reply_count + 1 } : t));
      setReplyBody('');
    } catch {
      toast('Could not post your reply', 'error');
    }
    setPosting(false);
  };

  if (loading || !thread) {
    return (
      <DashboardLayout activeLabel="Community">
        <div className="mx-auto max-w-3xl space-y-3">
          <div className="h-24 animate-pulse rounded-2xl bg-bg-tertiary" />
          <div className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" />
        </div>
      </DashboardLayout>
    );
  }

  const isThreadAuthor = Boolean(user && thread.author_id === user.id);

  return (
    <DashboardLayout activeLabel="Community">
      <div className="mx-auto max-w-3xl">
        <div className="flex gap-4 rounded-2xl border border-border bg-bg-secondary p-5">
          <VoteButton active={votedIds.has(thread.id)} count={thread.upvote_count} onToggle={() => handleVote('thread', thread.id)} />
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold text-text-primary">{thread.title}</h1>
            <p className="mt-1 text-xs text-text-secondary">{thread.author_name} · {thread.view_count} views · {thread.reply_count} replies</p>
            <p className="mt-3 whitespace-pre-wrap text-sm text-text-primary">{thread.body}</p>
          </div>
        </div>

        <div className="mt-6 space-y-3">
          {replies.map((r) => (
            <ReplyCard
              key={r.id}
              reply={r}
              isThreadAuthor={isThreadAuthor}
              voted={votedIds.has(r.id)}
              onVote={() => handleVote('reply', r.id)}
              onAccept={() => handleAccept(r.id)}
            />
          ))}
        </div>

        <div className="mt-6 rounded-2xl border border-border bg-bg-secondary p-4">
          <p className="mb-2 text-sm font-semibold text-text-primary">Write a reply</p>
          <textarea
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            rows={4}
            placeholder="Share what worked for you…"
            className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
          />
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              disabled={posting || !replyBody.trim()}
              onClick={handleReply}
              className="focus-ring rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
            >
              {posting ? 'Posting…' : 'Post reply'}
            </button>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
