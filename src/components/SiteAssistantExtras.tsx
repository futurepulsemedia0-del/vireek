import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Check, ThumbsUp, ThumbsDown, UserRound } from 'lucide-react';
import { supabase } from '@/lib/supabase';

export interface AssistantMeta {
  answerId?: string;
  sources?: { title: string; url: string }[];
  suggestions?: string[];
  handoff?: boolean;
}

interface Props {
  text: string;
  meta: AssistantMeta;
  isLast: boolean;
  disabled: boolean;
  onAsk: (q: string) => void;
  transcript: () => string;
}

/** Sources, copy, thumbs, human hand-off and follow-up chips shown under a finished assistant reply. */
export function SiteAssistantExtras({ text, meta, isLast, disabled, onAsk, transcript }: Props) {
  const [copied, setCopied] = useState(false);
  const [rating, setRating] = useState<1 | -1 | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable: ignore */
    }
  };

  const rate = async (value: 1 | -1) => {
    if (rating || !meta.answerId) return;
    setRating(value);
    // Anonymous RPC: one rating per answer (enforced in the database).
    const { error } = await supabase.rpc('submit_site_assistant_feedback', { p_answer_id: meta.answerId, p_rating: value });
    if (error) setRating(null);
  };

  const handoff = () =>
    window.dispatchEvent(new CustomEvent('vireek:open-live-chat', { detail: { source: 'ask-vireek', context: transcript().slice(-1500) } }));

  const iconBtn = 'focus-ring rounded-lg p-1.5 text-text-secondary hover:text-text-primary disabled:opacity-40';

  return (
    <div className="space-y-2 pl-11" dir="auto">
      {meta.sources && meta.sources.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
          <span className="font-medium">Learn more:</span>
          {meta.sources.map((s) => (
            <Link key={s.url} to={s.url} className="text-accent hover:underline">
              {s.title}
            </Link>
          ))}
        </p>
      )}

      <div className="flex items-center gap-1">
        <button type="button" onClick={copy} className={iconBtn} aria-label={copied ? 'Copied' : 'Copy answer'}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        {meta.answerId && (
          <>
            <button type="button" onClick={() => rate(1)} disabled={rating !== null} aria-pressed={rating === 1} className={iconBtn} aria-label="Helpful">
              <ThumbsUp size={14} />
            </button>
            <button type="button" onClick={() => rate(-1)} disabled={rating !== null} aria-pressed={rating === -1} className={iconBtn} aria-label="Not helpful">
              <ThumbsDown size={14} />
            </button>
          </>
        )}
        {meta.handoff && (
          <button type="button" onClick={handoff} className="focus-ring ms-2 inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-semibold text-accent hover:bg-bg-tertiary">
            <UserRound size={13} /> Talk to a human
          </button>
        )}
      </div>

      {isLast && meta.suggestions && meta.suggestions.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Suggested follow-up questions">
          {meta.suggestions.map((s) => (
            <button key={s} type="button" disabled={disabled} onClick={() => onAsk(s)} className="focus-ring rounded-full border border-border bg-bg-tertiary px-3 py-1 text-xs text-text-primary hover:border-accent disabled:opacity-40">
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
