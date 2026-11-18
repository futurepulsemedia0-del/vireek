import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Download, MoreHorizontal, Minus, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { OnlineDot } from '@/components/chat/ChatVisuals';
import { announce } from '@/lib/a11y/announcer';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import { cssVars } from '@/lib/cssVars';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useAskT } from '@/i18n/askVireekNamespace';
import { SUPPORT_HOURS_LABEL, getSupportStatus } from '@/lib/supportHours';
import { useBodyScrollLock } from '@/lib/askVireek/useBodyScrollLock';
import { exportAsText } from '@/lib/askVireek/storage';
import type { ChatApi } from '@/lib/askVireek/useAskVireekChat';
import type { AssistantContext } from '@/lib/askVireek/route';
import { AskVireekComposer } from './AskVireekComposer';
import { AskVireekMessage } from './AskVireekMessage';
import { AskVireekWelcome } from './AskVireekWelcome';
import { HandoffCard } from './HandoffCard';

interface Props {
  open: boolean;
  onClose: () => void;
  chat: ChatApi;
  context: AssistantContext;
  signedIn: boolean;
  prefill?: string;
}

const EXIT_MS = 200;

export function AskVireekPanel({ open, onClose, chat, context, signedIn, prefill }: Props) {
  const { t } = useAskT();
  const isDesktop = useMediaQuery('(min-width: 640px)', true);
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const [menu, setMenu] = useState(false);
  const [dy, setDy] = useState(0);
  const drag = useRef<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const status = getSupportStatus();

  const trapRef = useFocusTrap(open && mounted);
  useEscapeToClose(open, onClose);
  useBodyScrollLock(open && !isDesktop);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const id = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(id);
    }
    setVisible(false);
    const id = window.setTimeout(() => setMounted(false), EXIT_MS);
    return () => window.clearTimeout(id);
  }, [open]);

  const last = chat.messages[chat.messages.length - 1];
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [chat.messages.length, chat.thinking, last?.text.length]);

  // Screen readers: announce the finished answer once, not every streamed token.
  const lastDone = last && last.role === 'assistant' && !last.streaming ? last : null;
  useEffect(() => {
    if (lastDone && open) announce(`${t('message.assistant')}: ${lastDone.text.slice(0, 240)}`);
  }, [lastDone?.id, lastDone?.isError, open, t]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!mounted) return null;

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current !== null) setDy(Math.max(0, e.clientY - drag.current));
  };
  const onUp = () => {
    if (dy > 120) onClose();
    drag.current = null;
    setDy(0);
  };

  const download = () => {
    const text = exportAsText(chat.messages, { you: t('message.you'), assistant: t('message.assistant') });
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ask-vireek-conversation.txt';
    a.click();
    URL.revokeObjectURL(url);
    setMenu(false);
  };

  const position = isDesktop
    ? 'end-5 bottom-[calc(5.5rem+var(--vk-bottom-nav-h,0px)+var(--vk-bottom-bar-h,0px))] h-[min(40rem,calc(100dvh-8rem))] w-[min(25rem,calc(100vw-2rem))] rounded-overlay'
    : 'inset-x-0 bottom-0 h-[calc(100dvh-env(safe-area-inset-top)-1rem)] rounded-t-overlay pb-[env(safe-area-inset-bottom)]';

  const needsHandoff = chat.messages.some((m) => m.handoff);
  const dash = context.surface === 'dashboard';

  return (
    <>
      {!isDesktop && <div aria-hidden="true" onClick={onClose} className={`fixed inset-0 z-popover bg-bg-primary/60 transition-opacity duration-base ${visible ? 'opacity-100' : 'opacity-0'}`} />}
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('panel.title')}
        tabIndex={-1}
        style={cssVars({ '--sheet-dy': `${dy}px` })}
        className={`fixed z-popover flex flex-col overflow-hidden border border-border bg-bg-secondary shadow-elevation-4 transition-[opacity,transform] duration-base ease-out-expo print:hidden ${position} ${
          visible ? 'translate-y-[var(--sheet-dy)] opacity-100' : 'translate-y-4 opacity-0'
        }`}
      >
        {!isDesktop && (
          <div className="flex shrink-0 touch-none justify-center pt-2.5 pb-1" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} aria-hidden="true" title={t('panel.dragHandle')}>
            <span className="h-1 w-10 rounded-full bg-border" />
          </div>
        )}
        <header className="flex items-center gap-3 border-b border-border px-4 py-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent" aria-hidden="true">
            <Sparkles size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
              {t('panel.title')}
              <OnlineDot online={status.online} />
            </p>
            <p className="truncate text-xs text-text-secondary">{status.online ? t('panel.statusOnline') : t('panel.statusOffline', { hours: SUPPORT_HOURS_LABEL })}</p>
          </div>
          <div className="relative">
            <IconButton label={t('panel.menu')} icon={MoreHorizontal} size="sm" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)} />
            {menu && (
              <div role="menu" className="absolute end-0 top-full z-popover mt-1 w-56 rounded-surface border border-border bg-bg-secondary p-1 shadow-elevation-3">
                <button role="menuitem" type="button" className="focus-ring flex w-full items-center gap-2 rounded-control px-3 py-2 text-start text-sm text-text-primary hover:bg-bg-tertiary" onClick={() => { chat.reset(); setMenu(false); announce(t('panel.clearedToast')); }}>
                  <Plus size={14} aria-hidden="true" />{t('panel.newConversation')}
                </button>
                <button role="menuitem" type="button" disabled={chat.messages.length === 0} className="focus-ring flex w-full items-center gap-2 rounded-control px-3 py-2 text-start text-sm text-text-primary hover:bg-bg-tertiary disabled:opacity-40" onClick={download}>
                  <Download size={14} aria-hidden="true" />{t('panel.export')}
                </button>
                <button role="menuitem" type="button" disabled={chat.messages.length === 0} className="focus-ring flex w-full items-center gap-2 rounded-control px-3 py-2 text-start text-sm text-danger hover:bg-bg-tertiary disabled:opacity-40" onClick={() => { chat.reset(); setMenu(false); announce(t('panel.clearedToast')); }}>
                  <Trash2 size={14} aria-hidden="true" />{t('panel.clear')}
                </button>
              </div>
            )}
          </div>
          {isDesktop && <IconButton label={t('panel.minimize')} icon={Minus} size="sm" onClick={onClose} />}
          <IconButton label={t('panel.close')} icon={X} size="sm" onClick={onClose} />
        </header>

        <p className="border-b border-border bg-bg-tertiary px-4 py-1.5 text-center text-xs text-text-secondary">{dash ? t('panel.dashboardNotice') : t('panel.notice')}</p>

        <div
          ref={scroller}
          role="log"
          aria-live="off"
          aria-busy={chat.streaming || chat.thinking}
          aria-label={t('panel.title')}
          className="flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4"
        >
          {chat.messages.length === 0 ? (
            <AskVireekWelcome context={context} signedIn={signedIn} disabled={chat.thinking} onAsk={(q) => void chat.ask(q)} onClose={onClose} />
          ) : (
            chat.messages.map((m, i) => (
              <AskVireekMessage key={m.id} message={m} isLast={i === chat.messages.length - 1} busy={chat.thinking || chat.streaming} canRetry={chat.failure !== 'rate_limited'} onAsk={(q) => void chat.ask(q)} onRate={(id, r) => void chat.rate(id, r)} onRetry={() => void chat.retry()} />
            ))
          )}
          {chat.thinking && (
            <div role="status" aria-label={t('message.typing')} className="flex gap-1 px-2 py-3">
              <span className="h-2 w-2 animate-bounce rounded-full bg-text-secondary" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-text-secondary" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-text-secondary" />
            </div>
          )}
          {(needsHandoff || chat.failure === 'rate_limited') && (
            <HandoffCard messages={chat.messages} signedIn={signedIn} lowConfidence={chat.messages.some((m) => m.handoffReason === 'low_confidence')} onNavigate={onClose} />
          )}
        </div>

        <AskVireekComposer busy={chat.thinking || chat.streaming} prefill={prefill} onSend={(q) => void chat.ask(q)} onStop={chat.stop} autoFocus={visible} />
      </div>
    </>
  );
}
