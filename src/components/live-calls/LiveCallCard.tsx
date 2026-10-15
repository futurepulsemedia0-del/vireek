import { Phone, TriangleAlert as AlertTriangle, UserRound, Bot } from 'lucide-react';
import {
  LIVE_INTENT_LABELS,
  formatElapsed,
  type LiveCallRow,
} from '@/lib/liveCalls';

const sentimentStyle: Record<string, { label: string; cls: string }> = {
  positive: { label: 'Positive', cls: 'bg-success-500/10 text-success-500' },
  neutral: { label: 'Neutral', cls: 'bg-bg-tertiary text-text-secondary' },
  negative: { label: 'Negative', cls: 'bg-danger/10 text-danger' },
};

export function LiveCallBadges({ call }: { call: LiveCallRow }) {
  const sentiment = sentimentStyle[call.sentiment] ?? sentimentStyle.neutral;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {call.is_emergency && (
        <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-semibold text-danger">
          <AlertTriangle size={11} />
          Emergency
        </span>
      )}
      {(call.wants_human || call.human_transfer_requested) && (
        <span className="inline-flex items-center gap-1 rounded-full bg-warning-500/10 px-2 py-0.5 text-[11px] font-semibold text-warning-500">
          <UserRound size={11} />
          Wants a person
        </span>
      )}
      {call.intent && (
        <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
          {LIVE_INTENT_LABELS[call.intent]}
        </span>
      )}
      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${sentiment.cls}`}>{sentiment.label}</span>
      {call.handoff_status === 'requested' && (
        <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">Hand-off requested</span>
      )}
    </div>
  );
}

interface LiveCallCardProps {
  call: LiveCallRow;
  nowMs: number;
  selected: boolean;
  onSelect: (id: string) => void;
}

export function LiveCallCard({ call, nowMs, selected, onSelect }: LiveCallCardProps) {
  const live = call.status !== 'ended';
  const endMs = call.ended_at ? Date.parse(call.ended_at) : nowMs;
  const elapsed = formatElapsed(endMs - Date.parse(call.started_at));
  const who = call.caller_name || call.caller_phone || 'Unknown caller';

  return (
    <button
      type="button"
      onClick={() => onSelect(call.id)}
      aria-pressed={selected}
      className={`focus-ring w-full rounded-2xl border p-4 text-left transition-colors ${
        selected ? 'border-accent bg-accent/5' : call.is_emergency ? 'border-danger/40 bg-bg-secondary' : 'border-border bg-bg-secondary hover:bg-bg-tertiary'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-bg-tertiary text-text-secondary">
            <Phone size={16} />
            {live && (
              <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success-500 opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-success-500" />
              </span>
            )}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-text-primary">{who}</p>
            {call.caller_name && call.caller_phone && <p className="truncate text-xs text-text-secondary">{call.caller_phone}</p>}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono text-sm font-semibold tabular-nums text-text-primary">{elapsed}</p>
          <p className="text-[11px] text-text-secondary">{call.status === 'ringing' ? 'Ringing' : live ? 'In progress' : 'Ended'}</p>
        </div>
      </div>

      <div className="mt-3">
        <LiveCallBadges call={call} />
      </div>

      {call.last_line_preview && (
        <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-text-secondary">
          {call.last_line_role === 'assistant' ? <Bot size={13} className="mt-0.5 shrink-0" /> : <UserRound size={13} className="mt-0.5 shrink-0" />}
          <span className="line-clamp-2">{call.last_line_preview}</span>
        </p>
      )}
    </button>
  );
}
