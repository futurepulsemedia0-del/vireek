import { useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink, Loader2, Send, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import {
  PLATFORM_LABEL,
  REPLY_MAX,
  REPLY_WARNING_LABEL,
  draftReply,
  replyWarnings,
  safeReviewUrl,
  saveReply,
  type DraftInfo,
  type Overview,
  type PlatformInfo,
  type Review,
} from '@/lib/reputation';

export function ReplyEditor({
  review,
  platform,
  canPost,
  onChange,
}: {
  review: Review;
  platform: PlatformInfo | undefined;
  /** The review came from a connected source that supports posting replies through its API. */
  canPost: boolean;
  onChange: (o: Overview) => void;
}) {
  const { toast } = useToast();
  const [text, setText] = useState(review.draft_reply ?? review.reply_text ?? '');
  const [draftMeta, setDraftMeta] = useState<DraftInfo | null>(null);
  const [busy, setBusy] = useState<null | 'draft' | 'post' | 'mark'>(null);

  // Keep the editor in step if a draft arrives from elsewhere (e.g. after a refresh).
  useEffect(() => {
    if (!text && review.draft_reply) setText(review.draft_reply);
  }, [review.draft_reply, text]);

  const warnings = replyWarnings(text);
  const link = safeReviewUrl(review.review_url);
  const replied = review.status === 'replied';
  const label = PLATFORM_LABEL[review.platform];

  const generate = async () => {
    setBusy('draft');
    try {
      const res = await draftReply(review.id);
      setText(res.draft.reply);
      setDraftMeta(res.draft);
      onChange(res);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not draft a reply.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const submit = async (post: boolean) => {
    setBusy(post ? 'post' : 'mark');
    try {
      onChange(await saveReply(review.id, text, post));
      toast(post ? `Reply posted to ${label}.` : 'Marked as replied.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the reply.', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3 border-t border-border/70 pt-4">
      {replied && (
        <p className="text-xs text-text-secondary">
          Replied {review.reply_via === 'api' ? `through ${label}` : review.reply_via === 'platform' ? `on ${label}` : 'manually'}. You can update it below.
        </p>
      )}

      <Textarea
        aria-label={`Reply to ${review.reviewer_name}`}
        rows={5}
        value={text}
        maxLength={REPLY_MAX}
        placeholder="Write a reply, or let AI draft one for you…"
        helperText={`${text.length}/${REPLY_MAX}`}
        onChange={(e) => setText(e.target.value)}
      />

      {draftMeta && (
        <p className="flex items-start gap-1.5 text-xs text-text-secondary">
          <Sparkles size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          {draftMeta.source === 'ai'
            ? 'AI draft — read it carefully and make it yours before posting.'
            : 'AI is unavailable right now, so this is a generic template. Personalise it before posting.'}
        </p>
      )}
      {draftMeta?.flags.map((f) => (
        <p key={f} role="status" className="flex items-start gap-1.5 text-xs text-warning-500">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" /> Check: {f}
        </p>
      ))}
      {warnings.map((w) => (
        <p key={w} role="status" className="flex items-start gap-1.5 text-xs text-warning-500">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" /> {REPLY_WARNING_LABEL[w]}
        </p>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={generate} disabled={busy !== null}>
          {busy === 'draft' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}
          {text ? 'Redraft with AI' : 'Draft with AI'}
        </Button>
        {canPost ? (
          <Button type="button" size="sm" onClick={() => submit(true)} disabled={busy !== null || text.trim().length < 5}>
            {busy === 'post' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
            Post to {label}
          </Button>
        ) : (
          <Button type="button" size="sm" onClick={() => submit(false)} disabled={busy !== null || text.trim().length < 5}>
            {busy === 'mark' && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
            Mark as replied
          </Button>
        )}
        {link && (
          <a href={link} target="_blank" rel="noreferrer noopener" className="focus-ring inline-flex min-h-[40px] items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-accent hover:brightness-110">
            <ExternalLink size={14} aria-hidden="true" /> Open on {label}
          </a>
        )}
      </div>

      {!canPost && (
        <p className="text-xs text-text-secondary">
          {platform && !platform.reply
            ? platform.note
            : `Replies for this review can't be posted from here. Copy your reply, post it on ${label}, then mark it as replied.`}
        </p>
      )}
    </div>
  );
}
