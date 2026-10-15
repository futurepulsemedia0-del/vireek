/**
 * Support — /dashboard/support
 *
 * In-app tickets stored in support_conversations (kind = 'ticket') and worked
 * by Vireek staff in /staff/support-inbox. Scoped to the ACCOUNT OWNER so the
 * owner and every team member share one ticket list. See
 * supabase/migrations/20271009010000_support_tickets.sql.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, LifeBuoy, Plus } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { NewTicketForm } from '@/components/support/NewTicketForm';
import { TicketThread } from '@/components/support/TicketThread';
import { SlaBadge, StateBadge } from '@/components/support/TicketParts';
import { useRealtimeSubscription } from '@/lib/realtime';
import { fetchTickets } from '@/lib/supportTicketsApi';
import { filterTickets, sortTickets, ticketRef, type Ticket, type TicketFilter } from '@/lib/supportTickets';
import { SUPPORT_HOURS_LABEL } from '@/lib/supportHours';

const FILTERS: { value: TicketFilter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'all', label: 'All' },
];

export function SupportTicketsPage() {
  const { user, profile, teamMember, isOwner, profileLoading } = useAuth();
  const userId = user?.id;
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id; // same resolution as NotificationsContext

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [filter, setFilter] = useState<TicketFilter>('open');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(
    async (initial: boolean) => {
      if (!ownerId) return;
      if (initial) setStatus('loading');
      try {
        setTickets(await fetchTickets(ownerId));
        setStatus('ready');
      } catch {
        // A background refresh failing must not wipe a list the user is reading.
        if (initial) setStatus('error');
      }
    },
    [ownerId],
  );

  useEffect(() => {
    if (!profileLoading) void load(true);
  }, [load, profileLoading]);

  useRealtimeSubscription({
    channelName: `support-tickets-${ownerId ?? 'none'}`,
    table: 'support_conversations',
    event: '*',
    filter: ownerId ? `account_owner_id=eq.${ownerId}` : undefined,
    enabled: !!ownerId,
    onChange: () => void load(false),
  });

  const visible = useMemo(() => sortTickets(filterTickets(tickets, filter)), [tickets, filter]);
  const selected = tickets.find((t) => t.id === selectedId) ?? null;
  const openCount = useMemo(() => filterTickets(tickets, 'open').length, [tickets]);

  const ctx = ownerId && userId
    ? { ownerId, userId, name: profile?.company_name || profile?.full_name || null, email: profile?.email ?? null }
    : null;

  const showDetail = creating || !!selected; // mobile: swap list for detail

  return (
    <DashboardLayout activeLabel="Support">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight text-text-primary">
              <LifeBuoy size={24} className="text-accent" aria-hidden="true" /> Support
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Open a ticket and track it here. Our team replies {SUPPORT_HOURS_LABEL}.
            </p>
          </div>
          <Button size="sm" onClick={() => { setCreating(true); setSelectedId(null); }} disabled={!ctx}>
            <Plus size={14} aria-hidden="true" /> New ticket
          </Button>
        </header>

        {status === 'loading' && (
          <div className="grid gap-4 lg:grid-cols-[22rem_1fr]" aria-busy="true" aria-label="Loading tickets">
            <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full rounded-2xl" />)}</div>
            <Skeleton className="hidden h-80 w-full rounded-2xl lg:block" />
          </div>
        )}

        {status === 'error' && (
          <EmptyState icon={AlertCircle} title="We couldn’t load your tickets"
            description="Check your connection and try again. Nothing has been lost."
            action={{ label: 'Try again', onClick: () => void load(true) }} />
        )}

        {status === 'ready' && tickets.length === 0 && !creating && (
          <EmptyState icon={LifeBuoy} title="No tickets yet"
            description="Having trouble or a question? Open a ticket and our team will help."
            action={{ label: 'Open your first ticket', onClick: () => setCreating(true) }} />
        )}

        {status === 'ready' && (tickets.length > 0 || creating) && (
          <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
            <div className={showDetail ? 'hidden lg:block' : ''}>
              <div role="tablist" aria-label="Ticket filter" className="mb-3 flex gap-1 rounded-xl bg-bg-tertiary p-1">
                {FILTERS.map((f) => (
                  <button
                    key={f.value} type="button" role="tab" aria-selected={filter === f.value}
                    onClick={() => setFilter(f.value)}
                    className={`focus-ring flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                      filter === f.value ? 'bg-bg-secondary text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {f.label}{f.value === 'open' && openCount > 0 ? ` (${openCount})` : ''}
                  </button>
                ))}
              </div>
              {visible.length === 0 ? (
                <EmptyState icon={LifeBuoy} title={filter === 'resolved' ? 'No resolved tickets' : 'No open tickets'}
                  description={filter === 'resolved' ? 'Resolved tickets will be kept here.' : 'You’re all caught up.'} />
              ) : (
                <ul className="space-y-2">
                  {visible.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => { setSelectedId(t.id); setCreating(false); }}
                        aria-current={selectedId === t.id}
                        className={`focus-ring w-full rounded-2xl border p-4 text-left transition-colors ${
                          selectedId === t.id ? 'border-accent/50 bg-accent/5' : 'border-border bg-bg-secondary hover:border-accent/30'
                        }`}
                      >
                        <p className="text-xs text-text-secondary">{ticketRef(t.ticket_number)}</p>
                        <p className="mt-0.5 line-clamp-2 break-words text-sm font-semibold text-text-primary">{t.subject}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <StateBadge ticket={t} />
                          <SlaBadge ticket={t} />
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className={showDetail ? '' : 'hidden lg:block'}>
              {creating && ctx ? (
                <NewTicketForm
                  ctx={ctx}
                  onCancel={() => setCreating(false)}
                  onCreated={(t) => {
                    setTickets((prev) => [t, ...prev.filter((x) => x.id !== t.id)]);
                    setCreating(false);
                    setSelectedId(t.id);
                    setFilter('open');
                    void load(false);
                  }}
                />
              ) : selected && ctx ? (
                <TicketThread
                  key={selected.id} ticket={selected} ownerId={ctx.ownerId} userId={ctx.userId}
                  onBack={() => setSelectedId(null)} onChanged={() => void load(false)}
                />
              ) : (
                <EmptyState icon={LifeBuoy} title="Select a ticket" description="Pick a ticket to read the conversation and reply." />
              )}
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
