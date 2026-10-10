import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Activity } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { LiveIndicator } from '@/components/LiveIndicator';
import type { RealtimeStatus } from '@/lib/realtime';
import { NOTE_MAX_LENGTH, formatWhen, relativeTime, validateNote } from '@/lib/jobDetail';
import type { FeedItem, FeedKind } from '@/lib/jobDetail';
import { JobSection, SectionError, SectionSkeleton } from './JobSection';

const PAGE = 20;

const DOT_CLASS: Record<FeedKind, string> = {
  created: 'bg-accent',
  completed: 'bg-success-500',
  rescheduled: 'bg-warning-500',
  eta: 'bg-blue-500',
  signed: 'bg-success-500',
  invoice_sent: 'bg-blue-500',
  invoice_viewed: 'bg-blue-500',
  invoice_paid: 'bg-success-500',
  note: 'bg-accent',
  other: 'bg-text-secondary',
};

export function JobActivityFeed({
  items,
  loading,
  error,
  live,
  canEdit,
  onRetry,
  onAddNote,
}: {
  items: FeedItem[];
  loading: boolean;
  error: boolean;
  live: RealtimeStatus;
  canEdit: boolean;
  onRetry: () => void;
  /** Resolves true when the note was saved. */
  onAddNote: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [now, setNow] = useState(() => new Date());

  // Keep "5 min ago" labels fresh without refetching.
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  const invalid = validateNote(text);

  const post = async () => {
    if (posting || invalid) return;
    setPosting(true);
    const ok = await onAddNote(text);
    setPosting(false);
    if (ok) setText('');
  };

  let body: ReactNode;
  if (loading && items.length === 0) {
    body = <SectionSkeleton />;
  } else {
    body = (
      <div className="space-y-4">
        {error && <SectionError message="Could not load the full history." onRetry={onRetry} />}

        {canEdit && (
          <div className="space-y-2">
            <Textarea
              label="Add a note"
              rows={2}
              maxLength={NOTE_MAX_LENGTH}
              value={text}
              placeholder="Visible to your team on this job"
              onChange={(e) => setText(e.target.value)}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-text-secondary">
                {text.trim().length}/{NOTE_MAX_LENGTH}
              </span>
              <Button size="sm" disabled={posting || invalid !== null} onClick={() => void post()}>
                {posting ? 'Adding…' : 'Add note'}
              </Button>
            </div>
          </div>
        )}

        <ol className="space-y-4" aria-live="polite" aria-relevant="additions" aria-label="Job activity, newest first">
          {items.slice(0, limit).map((item) => (
            <li key={item.id} className="flex gap-3">
              <span aria-hidden="true" className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT_CLASS[item.kind]}`} />
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-primary">{item.title}</p>
                {item.detail && <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-text-secondary">{item.detail}</p>}
                <p className="mt-0.5 text-xs text-text-secondary">
                  <time dateTime={item.at} title={formatWhen(item.at)}>
                    {relativeTime(item.at, now)}
                  </time>
                  {item.actor ? ` · ${item.actor}` : ''}
                </p>
              </div>
            </li>
          ))}
        </ol>

        {items.length > limit && (
          <Button variant="ghost" size="sm" onClick={() => setLimit((l) => l + PAGE)}>
            Show {Math.min(PAGE, items.length - limit)} more
          </Button>
        )}
      </div>
    );
  }

  return (
    <JobSection title="Activity" icon={Activity} action={<LiveIndicator status={live} />}>
      {body}
    </JobSection>
  );
}
