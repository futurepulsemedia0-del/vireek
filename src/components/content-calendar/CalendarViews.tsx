import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, Plus } from 'lucide-react';
import {
  fmtDayLong,
  fmtTime,
  getChannel,
  isDraggable,
  isOverdue,
  isSameDay,
  monthGrid,
  parseDateKey,
  statusLabel,
  statusTone,
  toDateKey,
  weekDays,
  type CalendarEntry,
  type ContentItem,
  type StatusTone,
  type WeekStart,
} from '@/lib/contentCalendar';

const toneClass: Record<StatusTone, string> = {
  neutral: 'bg-bg-tertiary text-text-secondary',
  info: 'bg-accent/10 text-accent',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning-500/10 text-warning-500',
  danger: 'bg-danger/10 text-danger',
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${toneClass[statusTone(status)]}`}>{statusLabel(status)}</span>;
}

export interface DnD {
  draggingId: string | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDropOnDay: (date: Date) => void;
}

interface EntryProps {
  entry: CalendarEntry;
  now: Date;
  dnd: DnD;
  onOpen: (item: ContentItem) => void;
}

/** One-line chip used inside month/week cells. */
export function EntryChip({ entry, now, dnd, onOpen }: EntryProps) {
  if (entry.kind === 'campaign') {
    return (
      <Link
        to="/dashboard/email-campaigns"
        className="focus-ring flex min-w-0 items-center gap-1.5 rounded-md border border-dashed border-border bg-bg-primary px-1.5 py-1 text-left text-xs text-text-secondary hover:border-accent/40 hover:text-text-primary"
        title={`Email campaign — ${entry.campaign.name} (${statusLabel(entry.campaign.status)}). Opens Email Campaigns.`}
      >
        <Mail className="h-3 w-3 shrink-0" aria-hidden />
        <span className="shrink-0 tabular-nums">{fmtTime(entry.at)}</span>
        <span className="truncate">{entry.campaign.name}</span>
      </Link>
    );
  }
  const { item } = entry;
  const channel = getChannel(item.channel);
  const overdue = isOverdue(item, now);
  const canDrag = isDraggable(item.status);
  return (
    <button
      type="button"
      draggable={canDrag}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', item.id);
        e.dataTransfer.effectAllowed = 'move';
        dnd.onDragStart(item.id);
      }}
      onDragEnd={dnd.onDragEnd}
      onClick={() => onOpen(item)}
      aria-label={`${channel.label}: ${item.title}, ${statusLabel(item.status)}${item.scheduled_at ? `, ${fmtTime(item.scheduled_at)}` : ''}${overdue ? ', past due' : ''}`}
      className={`focus-ring flex w-full min-w-0 items-center gap-1.5 rounded-md border px-1.5 py-1 text-left text-xs transition-colors hover:border-accent/50 ${
        overdue ? 'border-warning-500/60 bg-warning-500/10' : 'border-border bg-bg-primary'
      } ${dnd.draggingId === item.id ? 'opacity-40' : ''} ${canDrag ? 'cursor-grab active:cursor-grabbing' : ''}`}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${channel.dot}`} aria-hidden />
      {item.scheduled_at && <span className="shrink-0 tabular-nums text-text-secondary">{fmtTime(item.scheduled_at)}</span>}
      <span className={`truncate text-text-primary ${item.status === 'cancelled' ? 'line-through opacity-60' : ''}`}>{item.title}</span>
    </button>
  );
}

/** Roomier row used in the agenda and the selected-day panel. */
export function EntryRow({ entry, now, onOpen }: Omit<EntryProps, 'dnd'>) {
  if (entry.kind === 'campaign') {
    return (
      <Link
        to="/dashboard/email-campaigns"
        className="focus-ring flex items-center gap-3 rounded-xl border border-dashed border-border bg-bg-primary p-3 hover:border-accent/40"
      >
        <Mail className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden />
        <span className="w-16 shrink-0 text-xs tabular-nums text-text-secondary">{fmtTime(entry.at)}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-text-primary">{entry.campaign.name}</span>
          <span className="text-xs text-text-secondary">Email campaign · managed in Email Campaigns</span>
        </span>
        <StatusBadge status={entry.campaign.status} />
      </Link>
    );
  }
  const { item } = entry;
  const channel = getChannel(item.channel);
  const overdue = isOverdue(item, now);
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className={`focus-ring flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors hover:border-accent/50 ${
        overdue ? 'border-warning-500/60 bg-warning-500/10' : 'border-border bg-bg-primary'
      }`}
    >
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${channel.dot}`} aria-hidden />
      <span className="w-16 shrink-0 text-xs tabular-nums text-text-secondary">{item.scheduled_at ? fmtTime(item.scheduled_at) : 'No time'}</span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-sm font-medium text-text-primary ${item.status === 'cancelled' ? 'line-through opacity-60' : ''}`}>{item.title}</span>
        <span className="block truncate text-xs text-text-secondary">
          {channel.label}
          {item.body ? ` · ${item.body}` : ''}
        </span>
      </span>
      {overdue && <span className="shrink-0 rounded-full bg-warning-500/10 px-2 py-0.5 text-[11px] font-medium text-warning-500">Past due</span>}
      <StatusBadge status={item.status} />
    </button>
  );
}

interface ViewProps {
  anchor: Date;
  weekStartsOn: WeekStart;
  now: Date;
  byDay: Map<string, CalendarEntry[]>;
  selectedKey: string;
  dnd: DnD;
  onSelectDay: (date: Date) => void;
  onCreate: (date: Date) => void;
  onOpen: (item: ContentItem) => void;
  onShowWeek: (date: Date) => void;
}

function useDropTarget(dnd: DnD) {
  const [over, setOver] = useState<string | null>(null);
  const props = (date: Date) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!dnd.draggingId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setOver(toDateKey(date));
    },
    onDragLeave: () => setOver((k) => (k === toDateKey(date) ? null : k)),
    onDrop: (e: React.DragEvent) => {
      if (!dnd.draggingId) return;
      e.preventDefault();
      setOver(null);
      dnd.onDropOnDay(date);
    },
  });
  return { over, props };
}

export function MonthView({ anchor, weekStartsOn, now, byDay, selectedKey, dnd, onSelectDay, onCreate, onOpen, onShowWeek }: ViewProps) {
  const grid = monthGrid(anchor, weekStartsOn);
  const { over, props } = useDropTarget(dnd);
  const MAX = 3;
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-bg-secondary">
      <div className="grid grid-cols-7 border-b border-border bg-bg-tertiary/60 text-center text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
        {grid.slice(0, 7).map((d) => (
          <div key={d.key} className="py-2">
            {d.date.toLocaleDateString([], { weekday: 'short' })}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {grid.map((cell, i) => {
          const entries = byDay.get(cell.key) ?? [];
          const isToday = isSameDay(cell.date, now);
          const selected = cell.key === selectedKey;
          const label = fmtDayLong(cell.date);
          return (
            <div
              key={cell.key}
              {...props(cell.date)}
              className={`group relative min-h-[56px] border-b border-r border-border/70 p-1 sm:min-h-[116px] sm:p-1.5 ${i % 7 === 6 ? 'border-r-0' : ''} ${
                cell.inMonth ? '' : 'bg-bg-primary/40 opacity-60'
              } ${over === cell.key ? 'bg-accent/10 ring-2 ring-inset ring-accent/50' : ''} ${selected ? 'bg-accent/5' : ''}`}
            >
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => onSelectDay(cell.date)}
                  aria-pressed={selected}
                  aria-label={`${label}${entries.length ? `, ${entries.length} item${entries.length === 1 ? '' : 's'}` : ''}`}
                  className={`focus-ring flex h-6 min-w-[1.5rem] items-center justify-center rounded-full px-1 text-xs font-medium ${
                    isToday ? 'bg-accent text-white' : 'text-text-primary hover:bg-bg-tertiary'
                  }`}
                >
                  {cell.date.getDate()}
                </button>
                <button
                  type="button"
                  onClick={() => onCreate(cell.date)}
                  aria-label={`Add content on ${label}`}
                  className="focus-ring hidden h-6 w-6 items-center justify-center rounded-full text-text-secondary opacity-0 transition-opacity hover:bg-bg-tertiary hover:text-text-primary focus:opacity-100 group-hover:opacity-100 sm:flex"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>

              {/* Desktop: chips */}
              <div className="mt-1 hidden space-y-1 sm:block">
                {entries.slice(0, MAX).map((e) => (
                  <EntryChip key={e.key} entry={e} now={now} dnd={dnd} onOpen={onOpen} />
                ))}
                {entries.length > MAX && (
                  <button type="button" onClick={() => onShowWeek(cell.date)} className="focus-ring w-full rounded-md px-1.5 py-0.5 text-left text-xs font-medium text-accent hover:underline">
                    +{entries.length - MAX} more
                  </button>
                )}
              </div>

              {/* Mobile: dots (tap the day to see the list below the grid) */}
              <div className="mt-1 flex flex-wrap justify-center gap-0.5 sm:hidden" aria-hidden>
                {entries.slice(0, 4).map((e) => (
                  <span key={e.key} className={`h-1.5 w-1.5 rounded-full ${e.kind === 'content' ? getChannel(e.item.channel).dot : 'bg-text-secondary'}`} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function WeekView({ anchor, weekStartsOn, now, byDay, dnd, onCreate, onOpen }: ViewProps) {
  const days = weekDays(anchor, weekStartsOn);
  const { over, props } = useDropTarget(dnd);
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-7 md:gap-2">
      {days.map((date) => {
        const key = toDateKey(date);
        const entries = byDay.get(key) ?? [];
        const isToday = isSameDay(date, now);
        return (
          <section
            key={key}
            aria-label={fmtDayLong(date)}
            {...props(date)}
            className={`rounded-2xl border bg-bg-secondary p-2.5 md:min-h-[220px] ${isToday ? 'border-accent/60' : 'border-border'} ${over === key ? 'bg-accent/10 ring-2 ring-accent/50' : ''}`}
          >
            <div className="mb-2 flex items-center justify-between">
              <h3 className={`text-sm font-semibold ${isToday ? 'text-accent' : 'text-text-primary'}`}>
                {date.toLocaleDateString([], { weekday: 'short' })} <span className="font-normal text-text-secondary">{date.getDate()}</span>
              </h3>
              <button
                type="button"
                onClick={() => onCreate(date)}
                aria-label={`Add content on ${fmtDayLong(date)}`}
                className="focus-ring flex h-7 w-7 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
              >
                <Plus className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <div className="space-y-1.5">
              {entries.map((e) => (
                <EntryChip key={e.key} entry={e} now={now} dnd={dnd} onOpen={onOpen} />
              ))}
              {entries.length === 0 && <p className="px-1 text-xs text-text-secondary/70">Nothing planned</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function DayList({ date, entries, now, onOpen, onCreate }: { date: Date; entries: CalendarEntry[]; now: Date; onOpen: (item: ContentItem) => void; onCreate: (date: Date) => void }) {
  return (
    <section aria-label={fmtDayLong(date)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-primary">{fmtDayLong(date)}</h3>
        <button type="button" onClick={() => onCreate(date)} className="focus-ring inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10">
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-3 py-4 text-sm text-text-secondary">Nothing planned for this day.</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((e) => (
            <li key={e.key}>
              <EntryRow entry={e} now={now} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AgendaView({ byDay, now, onOpen, onCreate }: Pick<ViewProps, 'byDay' | 'now' | 'onOpen' | 'onCreate'>) {
  const keys = [...byDay.keys()].sort();
  return (
    <div className="space-y-5">
      {keys.map((key) => {
        const date = parseDateKey(key) ?? new Date();
        return <DayList key={key} date={date} entries={byDay.get(key) ?? []} now={now} onOpen={onOpen} onCreate={onCreate} />;
      })}
    </div>
  );
}
