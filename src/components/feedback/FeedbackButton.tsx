import { MessageSquarePlus } from 'lucide-react';
import { openFeedback } from '@/lib/feedback/events';

/** Header entry point. Keyboard: Tab to it, or press "f" then "b" anywhere in the dashboard. */
export function FeedbackButton() {
  return (
    <button type="button" onClick={() => openFeedback()} aria-label="Send feedback" aria-keyshortcuts="f b" title="Send feedback (F then B)"
      className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary">
      <MessageSquarePlus size={18} aria-hidden="true" />
    </button>
  );
}
