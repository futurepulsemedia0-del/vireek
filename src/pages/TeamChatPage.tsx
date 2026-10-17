import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DashboardLayout } from '@/components/DashboardNav';
import { ChatChannelList } from '@/components/teamchat/ChatChannelList';
import { ChatPushPrompt } from '@/components/teamchat/ChatPushPrompt';
import { ChatThreadPanel } from '@/components/teamchat/ChatThreadPanel';
import { EmptyState } from '@/components/EmptyState';
import { LiveIndicator } from '@/components/LiveIndicator';
import { useAuth } from '@/contexts/AuthContext';
import { useChatUnread } from '@/contexts/ChatUnreadContext';
import { useToast } from '@/contexts/ToastContext';
import { useChatInbox } from '@/hooks/useTeamChat';
import { ChatError, openDirectChannel, openJobChannel } from '@/lib/teamChatApi';
import { MessagesSquare } from 'lucide-react';

/**
 * Team Chat (/dashboard/team-chat) — office <-> technicians.
 *   ?c=<channelId>  open a conversation        (push notifications deep-link here)
 *   ?job=<jobId>    open (or create) that job's channel
 *   ?dm=<userId>    open (or create) a direct message
 */
export function TeamChatPage() {
  const { user, permissions, isOwner } = useAuth();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const me = user?.id ?? '';
  const inbox = useChatInbox(user?.id);
  const unread = useChatUnread();
  const handledRef = useRef<string | null>(null);

  const activeId = params.get('c');
  const active = useMemo(() => inbox.channels.find((c) => c.id === activeId) ?? null, [inbox.channels, activeId]);
  const isManager = isOwner || permissions.can_view_all_jobs;

  const select = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams();
      if (id) next.set('c', id);
      setParams(next, { replace: false });
    },
    [setParams],
  );

  // ?job= / ?dm= -> resolve to a channel id, then normalise the URL to ?c=
  useEffect(() => {
    const job = params.get('job');
    const dm = params.get('dm');
    const token = job ? `job:${job}` : dm ? `dm:${dm}` : null;
    if (!token || handledRef.current === token || !user) return;
    handledRef.current = token;
    (async () => {
      try {
        const id = job ? await openJobChannel(job) : await openDirectChannel(dm as string);
        await inbox.ensureChannel(id);
        const next = new URLSearchParams();
        next.set('c', id);
        setParams(next, { replace: true });
      } catch (e) {
        toast(e instanceof ChatError ? e.message : 'Could not open that conversation.', 'error');
        setParams(new URLSearchParams(), { replace: true });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, user]);

  // ?c= that is not in the list yet (deep link from a push) -> fetch it once.
  useEffect(() => {
    if (!activeId || active || inbox.loading) return;
    let alive = true;
    inbox
      .ensureChannel(activeId)
      .then((c) => {
        if (alive && !c) {
          toast('That conversation is not available to you.', 'error');
          select(null);
        }
      })
      .catch(() => alive && select(null));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, active, inbox.loading]);

  useEffect(() => {
    unread.setActiveChannel(activeId);
    return () => unread.setActiveChannel(null);
  }, [activeId, unread]);

  const startDirect = useCallback(
    async (userId: string) => {
      try {
        const id = await openDirectChannel(userId);
        await inbox.ensureChannel(id);
        select(id);
      } catch (e) {
        toast(e instanceof ChatError ? e.message : 'Could not start the conversation.', 'error');
      }
    },
    [inbox, select, toast],
  );

  return (
    <DashboardLayout activeLabel="Team Chat">
      <div className="mb-4 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold text-text-primary">Team Chat</h1>
          <p className="text-sm text-text-secondary">Office and technicians, per job or one-to-one.</p>
        </div>
        <LiveIndicator status={inbox.status} />
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card">
        <ChatPushPrompt />
        <div className="grid h-[calc(100dvh-14rem)] min-h-[460px] grid-cols-1 lg:grid-cols-[340px_minmax(0,1fr)]">
          <div className={`${activeId ? 'hidden lg:block' : 'block'} min-h-0`}>
            <ChatChannelList
              channels={inbox.channels}
              people={inbox.people}
              peopleById={inbox.peopleById}
              me={me}
              counts={unread.counts}
              activeId={activeId}
              loading={inbox.loading}
              error={inbox.error}
              onSelect={select}
              onStartDirect={startDirect}
            />
          </div>
          <div className={`${activeId ? 'block' : 'hidden lg:block'} min-h-0`}>
            {active ? (
              <ChatThreadPanel
                key={active.id}
                channel={active}
                me={me}
                peopleById={inbox.peopleById}
                jobHref={(jobId) => (isManager ? `/dashboard/jobs/${jobId}` : `/tech/job/${jobId}`)}
                onBack={() => select(null)}
                onRead={unread.refresh}
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <EmptyState
                  icon={MessagesSquare}
                  title="Select a conversation"
                  description="Pick a job or a teammate on the left to start chatting."
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
