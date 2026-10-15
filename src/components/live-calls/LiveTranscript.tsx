import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, Bot, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/Skeleton';
import type { LiveCallLine } from '@/lib/liveCalls';

interface LiveTranscriptProps {
  lines: LiveCallLine[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  /** True while the call is still going, so the empty state can say "waiting". */
  live: boolean;
}

const STICK_THRESHOLD_PX = 80;

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

export function LiveTranscript({ lines, loading, error, onRetry, live }: LiveTranscriptProps) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const stuck = useRef(true);
  const seen = useRef(0);
  const [unseen, setUnseen] = useState(0);

  const jumpToLatest = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stuck.current = true;
    seen.current = lines.length;
    setUnseen(0);
  };

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
    if (stuck.current) {
      seen.current = lines.length;
      setUnseen(0);
    }
  };

  // New call selected -> start pinned to the bottom again.
  useEffect(() => {
    stuck.current = true;
    seen.current = 0;
    setUnseen(0);
  }, [loading]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (stuck.current) {
      el.scrollTop = el.scrollHeight;
      seen.current = lines.length;
      setUnseen(0);
    } else {
      setUnseen(Math.max(0, lines.length - seen.current));
    }
  }, [lines]);

  if (loading) {
    return (
      <div className="space-y-3 p-4" aria-busy="true">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="ml-auto h-10 w-1/2" />
        <Skeleton className="h-10 w-3/4" />
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="flex flex-col items-center px-4 py-10 text-center">
        <p className="text-sm font-semibold text-text-primary">Couldn't load the transcript</p>
        <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="relative">
      <div
        ref={scroller}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-label="Live call transcript"
        className="max-h-[52vh] min-h-[240px] space-y-3 overflow-y-auto p-4"
      >
        {lines.length === 0 ? (
          <p className="py-16 text-center text-sm text-text-secondary">
            {live ? 'Waiting for the first words…' : 'A transcript was not captured for this call.'}
          </p>
        ) : (
          lines.map((l) => (
            <div key={l.id} className={`flex gap-2 ${l.role === 'caller' ? 'justify-start' : 'justify-end'}`}>
              {l.role === 'caller' && (
                <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-tertiary text-text-secondary">
                  <UserRound size={14} />
                </span>
              )}
              <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${l.role === 'caller' ? 'bg-bg-tertiary text-text-primary' : 'bg-accent/10 text-text-primary'}`}>
                <p className="mb-0.5 text-[11px] font-medium text-text-secondary">
                  {l.role === 'caller' ? 'Caller' : 'AI assistant'} · {timeOf(l.created_at)}
                </p>
                <p className="whitespace-pre-wrap">{l.content}</p>
              </div>
              {l.role === 'assistant' && (
                <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
                  <Bot size={14} />
                </span>
              )}
            </div>
          ))
        )}
      </div>
      {unseen > 0 && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="focus-ring absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-accent px-3.5 py-2 text-xs font-semibold text-white shadow-lg"
        >
          <ArrowDown size={13} />
          {unseen} new {unseen === 1 ? 'message' : 'messages'}
        </button>
      )}
    </div>
  );
}
