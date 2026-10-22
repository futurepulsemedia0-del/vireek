import {
  Ban,
  CalendarCheck,
  DollarSign,
  FileText,
  MessageSquare,
  MousePointerClick,
  PhoneMissed,
  PhoneOutgoing,
  Reply,
  Timer,
  User,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { buildTimeline, type EventTone, type RescueEvent, type RescueEventKind, type TimelineItem } from '@/lib/rescueLoop';

const ICONS: Record<RescueEventKind | 'sla_limit', LucideIcon> = {
  call_missed: PhoneMissed,
  text_sent: MessageSquare,
  callback_attempt: PhoneOutgoing,
  followup_text: MessageSquare,
  followup_call: PhoneOutgoing,
  customer_reply: Reply,
  manual_text: MessageSquare,
  human_followup: User,
  link_click: MousePointerClick,
  booked: CalendarCheck,
  quote_sent: FileText,
  quote_accepted: FileText,
  quote_declined: FileText,
  payment_received: DollarSign,
  loop_stopped: Ban,
  closed: Ban,
  sla_limit: Timer,
};

const TONE_DOT: Record<EventTone, string> = {
  good: 'bg-success-500/15 text-success-500',
  warn: 'bg-warning-500/15 text-warning-500',
  bad: 'bg-danger-500/15 text-danger-500',
  neutral: 'bg-bg-tertiary text-text-secondary',
  pending: 'bg-accent/10 text-accent',
};

interface Props {
  events: RescueEvent[];
  clockStart: string;
  limitSeconds: number;
  now: number;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

export function RescueTimeline({ events, clockStart, limitSeconds, now, loading, error, onRetry }: Props) {
  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading timeline">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex gap-3">
            <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-bg-tertiary" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-1/3 animate-pulse rounded bg-bg-tertiary" />
              <div className="h-3 w-2/3 animate-pulse rounded bg-bg-tertiary" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-danger-500/30 bg-danger-500/5 px-4 py-3 text-sm text-danger-500">
        <span>{error}</span>
        {onRetry && (
          <button type="button" onClick={onRetry} className="focus-ring shrink-0 rounded-lg border border-danger-500/30 px-3 py-1 text-xs font-medium">
            Retry
          </button>
        )}
      </div>
    );
  }

  const items = buildTimeline(events, { clockStart, limitSeconds, now });
  const realEvents = items.filter((i) => i.type === 'event').length;

  return (
    <div>
      {realEvents <= 1 && (
        <p className="mb-3 rounded-xl bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">
          Nothing has happened after the call yet. If the text-back automation is installed it will appear here as soon as it runs.
        </p>
      )}
      <ol aria-label="Rescue timeline" className="relative space-y-4 border-l border-border pl-6">
        {items.map((item) => (
          <TimelineRow key={item.key} item={item} />
        ))}
      </ol>
    </div>
  );
}

function TimelineRow({ item }: { item: TimelineItem }) {
  const Icon = ICONS[item.kind];
  const marker = item.type === 'sla_marker';
  const dot = marker ? (item.passed ? 'bg-bg-tertiary text-text-secondary' : 'bg-accent/10 text-accent') : TONE_DOT[item.tone];

  return (
    <li className="relative">
      <span className={`absolute -left-[2.35rem] flex h-8 w-8 items-center justify-center rounded-full ${dot}`}>
        <Icon size={14} aria-hidden="true" />
      </span>
      <div className={marker ? 'border-t border-dashed border-border pt-1' : ''}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className={`text-sm font-semibold ${marker ? 'text-text-secondary' : 'text-text-primary'}`}>{item.title}</span>
          {item.outcomeLabel && item.tone !== 'good' && (
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE_DOT[item.tone]}`}>{item.outcomeLabel}</span>
          )}
          {item.overdue && <span className="rounded-full bg-warning-500/15 px-2 py-0.5 text-[11px] font-medium text-warning-500">Overdue</span>}
          {item.automated && <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">Automatic</span>}
          <time className="ml-auto text-xs tabular-nums text-text-secondary" dateTime={new Date(item.at).toISOString()}>
            {item.offsetLabel}
            {!marker && <span className="ml-2 hidden sm:inline">{formatClock(item.at)}</span>}
          </time>
        </div>
        {item.detail && <p className="mt-0.5 text-sm text-text-secondary">{item.detail}</p>}
        {marker && <p className="mt-0.5 text-xs text-text-secondary">{item.passed ? 'The limit has passed.' : 'The caller should be answered before this line.'}</p>}
      </div>
    </li>
  );
}
