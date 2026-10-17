import { useChatUnread } from '@/contexts/ChatUnreadContext';
import { unreadLabel } from '@/lib/teamChat';

/** Unread pill for the sidebar "Team Chat" link. Renders nothing at zero. */
export function ChatNavBadge() {
  const { total } = useChatUnread();
  if (total <= 0) return null;
  return (
    <span className="ml-auto inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-semibold leading-5 text-white">
      <span aria-hidden="true">{unreadLabel(total)}</span>
      <span className="sr-only">{total} unread chat messages</span>
    </span>
  );
}
