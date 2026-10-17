import { useMemo, useState } from 'react';
import { Briefcase, Image as ImageIcon, MessageSquarePlus, Mic, Search, User, X } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import {
  channelTitle,
  previewText,
  unreadLabel,
  type ChatChannel,
  type ChatPerson,
} from '@/lib/teamChat';

type Filter = 'all' | 'job' | 'direct';

interface Props {
  channels: ChatChannel[];
  people: ChatPerson[];
  peopleById: Map<string, ChatPerson>;
  me: string;
  counts: Map<string, number>;
  activeId: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  onStartDirect: (userId: string) => void;
}

function shortTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export function ChatChannelList({ channels, people, peopleById, me, counts, activeId, loading, error, onSelect, onStartDirect }: Props) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [picking, setPicking] = useState(false);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return channels.filter((c) => {
      if (filter !== 'all' && c.kind !== filter) return false;
      if (!q) return true;
      return channelTitle(c, me, peopleById).toLowerCase().includes(q);
    });
  }, [channels, filter, query, me, peopleById]);

  const others = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people.filter((p) => !p.is_self && (!q || p.name.toLowerCase().includes(q)));
  }, [people, query]);

  return (
    <div className="flex h-full min-h-0 flex-col border-border bg-bg-secondary lg:border-r">
      <div className="space-y-3 border-b border-border p-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={picking ? 'Find a teammate' : 'Search chats'}
              aria-label={picking ? 'Find a teammate' : 'Search chats'}
              className="focus-ring w-full rounded-xl border border-border bg-bg-primary py-2.5 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-secondary/60 focus-visible:border-accent"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              setPicking((v) => !v);
              setQuery('');
            }}
            aria-label={picking ? 'Close new message' : 'New direct message'}
            aria-pressed={picking}
            className="focus-ring flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-border text-text-primary hover:bg-bg-tertiary"
          >
            {picking ? <X size={18} /> : <MessageSquarePlus size={18} />}
          </button>
        </div>

        {!picking && (
          <div className="flex gap-1.5" role="tablist" aria-label="Filter conversations">
            {(
              [
                ['all', 'All'],
                ['job', 'Jobs'],
                ['direct', 'People'],
              ] as [Filter, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={filter === key}
                onClick={() => setFilter(key)}
                className={`focus-ring rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  filter === key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <p role="alert" className="m-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        {picking ? (
          others.length === 0 ? (
            <EmptyState icon={User} title="No teammates found" description="Invite people from the Team page to message them here." />
          ) : (
            <ul className="p-2">
              {others.map((p) => (
                <li key={p.user_id}>
                  <button
                    type="button"
                    onClick={() => {
                      setPicking(false);
                      setQuery('');
                      onStartDirect(p.user_id);
                    }}
                    className="focus-ring flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-bg-tertiary"
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent/10 text-sm font-semibold text-accent">
                      {p.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-text-primary">{p.name}</span>
                      <span className="block text-xs capitalize text-text-secondary">{p.role}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : loading ? (
          <div className="p-3">
            <SkeletonCardList count={5} rows={2} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Briefcase}
            title={query ? 'No chats match your search' : 'No conversations yet'}
            description={query ? undefined : 'Open a job and tap Chat, or start a direct message with the + button.'}
          />
        ) : (
          <ul>
            {rows.map((c) => {
              const unread = counts.get(c.id) ?? 0;
              const active = c.id === activeId;
              const senderName = c.last_message_sender_id === me ? 'You' : c.kind === 'job' ? peopleById.get(c.last_message_sender_id ?? '')?.name : null;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(c.id)}
                    aria-current={active ? 'true' : undefined}
                    className={`focus-ring flex w-full items-start gap-3 border-b border-border/60 px-4 py-3 text-left transition-colors ${
                      active ? 'bg-accent/10' : 'hover:bg-bg-tertiary'
                    }`}
                  >
                    <span
                      className={`mt-0.5 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full ${
                        c.kind === 'job' ? 'bg-warning-500/10 text-warning-500' : 'bg-accent/10 text-accent'
                      }`}
                      aria-hidden="true"
                    >
                      {c.kind === 'job' ? <Briefcase size={18} /> : <User size={18} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className={`truncate text-sm ${unread ? 'font-semibold text-text-primary' : 'font-medium text-text-primary'}`}>
                          {channelTitle(c, me, peopleById)}
                        </span>
                        <span className="flex-shrink-0 text-xs text-text-secondary">{shortTime(c.last_message_at)}</span>
                      </span>
                      <span className="mt-0.5 flex items-center justify-between gap-2">
                        <span className={`flex min-w-0 items-center gap-1 truncate text-sm ${unread ? 'text-text-primary' : 'text-text-secondary'}`}>
                          {c.last_message_kind === 'image' && <ImageIcon size={14} className="flex-shrink-0" aria-hidden="true" />}
                          {c.last_message_kind === 'voice' && <Mic size={14} className="flex-shrink-0" aria-hidden="true" />}
                          <span className="truncate">
                            {c.last_message_kind ? previewText(c.last_message_kind, c.last_message_preview, senderName) : 'No messages yet'}
                          </span>
                        </span>
                        {unread > 0 && (
                          <span className="inline-flex min-w-[1.25rem] flex-shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-semibold leading-5 text-white">
                            <span aria-hidden="true">{unreadLabel(unread)}</span>
                            <span className="sr-only">{unread} unread</span>
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
