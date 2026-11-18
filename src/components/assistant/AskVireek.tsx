import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useAskT } from '@/i18n/askVireekNamespace';
import { getAssistantContext } from '@/lib/askVireek/route';
import { isAssistantShortcut } from '@/lib/askVireek/shortcut';
import { OPEN_ASSISTANT_EVENT, OPEN_LIVE_CHAT_EVENT, consumePendingOpen, type OpenAssistantDetail } from '@/lib/askVireek/handoff';
import { useAskVireekChat } from '@/lib/askVireek/useAskVireekChat';
import type { FailureKind } from '@/lib/askVireek/client';
import { AskVireekLauncher } from './AskVireekLauncher';
import { AskVireekPanel } from './AskVireekPanel';

/**
 * Unified support launcher + panel. Mounted once from main.tsx (lazy, after idle).
 * Routes: see src/lib/askVireek/route.ts. Public knowledge only: it never reads account data.
 */
export function AskVireek() {
  const { t } = useAskT();
  const { pathname, hash } = useLocation();
  const { user } = useAuth();
  const context = useMemo(() => getAssistantContext(pathname), [pathname]);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(false);
  const [prefill, setPrefill] = useState<string | undefined>();

  const failureText = useMemo<Record<FailureKind, string>>(
    () => ({ offline: t('states.offline'), rate_limited: t('states.rateLimited'), invalid: t('composer.tooLong'), error: t('states.error') }),
    [t],
  );
  const chat = useAskVireekChat(pathname, failureText);

  const hidden = context.surface === 'hidden';

  // Close on navigation to a hidden route; open/ask from anywhere via events.
  useEffect(() => {
    if (hidden) setOpen(false);
  }, [hidden]);

  useEffect(() => {
    const apply = (d: OpenAssistantDetail) => {
      consumePendingOpen();
      setOpen(true);
      if (d.prefill) setPrefill(d.prefill);
      if (d.ask) void chat.ask(d.ask);
    };
    const onOpen = (e: Event) => apply((e as CustomEvent<OpenAssistantDetail>).detail ?? {});
    const waiting = consumePendingOpen();
    if (waiting) apply(waiting);
    const onLiveChat = () => setOpen(false); // one panel at a time: live chat takes the slot
    window.addEventListener(OPEN_ASSISTANT_EVENT, onOpen);
    window.addEventListener(OPEN_LIVE_CHAT_EVENT, onLiveChat);
    return () => {
      window.removeEventListener(OPEN_ASSISTANT_EVENT, onOpen);
      window.removeEventListener(OPEN_LIVE_CHAT_EVENT, onLiveChat);
    };
  }, [chat]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (hidden || !isAssistantShortcut(e, e.target as HTMLElement | null)) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hidden]);

  // A reply that finishes while the panel is closed shows an unread dot.
  const last = chat.messages[chat.messages.length - 1];
  const finishedWhileClosed = !open && last?.role === 'assistant' && !last.streaming && !last.isError;
  useEffect(() => {
    if (finishedWhileClosed) setUnread(true);
  }, [finishedWhileClosed, last?.id]);
  useEffect(() => {
    if (open) setUnread(false);
  }, [open]);

  // Deep link / menu entry: any URL ending in #ask-vireek opens the assistant (footer, command palette, emails).
  useEffect(() => {
    if (hash === '#ask-vireek' && !hidden) setOpen(true);
  }, [hash, hidden]);

  const toggle = useCallback(() => setOpen((v) => !v), []);
  if (hidden) return null;

  return (
    <>
      <AskVireekLauncher open={open} unread={unread} onToggle={toggle} />
      <AskVireekPanel open={open} onClose={() => setOpen(false)} chat={chat} context={context} signedIn={!!user} prefill={prefill} />
    </>
  );
}
