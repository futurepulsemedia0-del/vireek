import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { getPushState, isPushSupported, subscribeToPush, type PushSupportState } from '@/lib/push';
import { Button } from '@/components/ui/Button';

/**
 * Asks once to enable push so chat messages reach a phone with the app closed.
 * Also silently re-registers an already-granted device ONCE so its subscription is
 * linked to this person (push_subscriptions.subscriber_id) — chat pushes are per-person.
 */
export function ChatPushPrompt() {
  const { user } = useAuth();
  const [state, setState] = useState<PushSupportState>('unsupported');
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const flag = user ? `vk-chat-push-linked-${user.id}` : null;

  useEffect(() => {
    if (!user || !flag || !isPushSupported()) return;
    let alive = true;
    (async () => {
      const s = await getPushState();
      if (!alive) return;
      setState(s);
      let linked = false;
      try {
        linked = localStorage.getItem(flag) === '1';
      } catch {
        linked = true; // cannot persist -> do not loop
      }
      if (s === 'subscribed' && !linked) {
        const r = await subscribeToPush(); // permission already granted: no prompt
        if (r.success) {
          try {
            localStorage.setItem(flag, '1');
          } catch {
            /* ignore */
          }
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [user, flag]);

  if (dismissed || state !== 'not-subscribed') return null;

  return (
    <div className="flex items-center gap-3 border-b border-border bg-accent/5 px-4 py-3">
      <Bell size={18} className="flex-shrink-0 text-accent" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-sm text-text-primary">Turn on notifications to hear about new messages when the app is closed.</p>
      <Button
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const r = await subscribeToPush();
          setBusy(false);
          if (r.success) {
            if (flag) {
              try {
                localStorage.setItem(flag, '1');
              } catch {
                /* ignore */
              }
            }
            setState('subscribed');
          } else {
            setState(await getPushState());
          }
        }}
      >
        Enable
      </Button>
      <button type="button" onClick={() => setDismissed(true)} className="focus-ring rounded-lg px-2 py-1 text-sm text-text-secondary hover:text-text-primary">
        Later
      </button>
    </div>
  );
}
