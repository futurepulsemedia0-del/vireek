import { Link } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { useWhatsNew } from '@/contexts/WhatsNewContext';
import { badgeLabel } from '@/lib/whatsNew';

/** Header icon with the unread badge; links to the feed. */
export function WhatsNewButton() {
  const { unreadCount } = useWhatsNew();
  const label = badgeLabel(unreadCount);

  return (
    <Link
      to="/dashboard/whats-new"
      aria-label={unreadCount > 0 ? `What’s new, ${unreadCount} unread` : 'What’s new'}
      className="focus-ring relative flex h-10 w-10 items-center justify-center rounded-xl text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
    >
      <Sparkles size={18} aria-hidden="true" />
      {label && (
        <span
          data-testid="whats-new-badge"
          className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold leading-none text-white"
        >
          {label}
        </span>
      )}
    </Link>
  );
}
