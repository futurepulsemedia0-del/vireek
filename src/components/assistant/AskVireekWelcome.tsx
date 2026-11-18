import { Link } from 'react-router-dom';
import { BookOpen, Database, MessageCircle, Ticket } from 'lucide-react';
import { useAskT } from '@/i18n/askVireekNamespace';
import { SUGGESTION_KEYS, type AssistantContext } from '@/lib/askVireek/route';
import { OPEN_ACCOUNT_ASSISTANT_EVENT, OPEN_LIVE_CHAT_EVENT, ticketHref } from '@/lib/askVireek/handoff';

interface Props {
  context: AssistantContext;
  signedIn: boolean;
  disabled: boolean;
  onAsk: (q: string) => void;
  onClose: () => void;
}

const pathBtn = 'focus-ring flex min-h-touch items-center gap-2 rounded-control border border-border bg-bg-secondary px-3 text-start text-sm text-text-primary hover:border-accent';

export function AskVireekWelcome({ context, signedIn, disabled, onAsk, onClose }: Props) {
  const { t } = useAskT();
  const dash = context.surface === 'dashboard';
  const keys = SUGGESTION_KEYS[context.topic].slice(0, 6);
  return (
    <div className="space-y-4">
      <p dir="auto" className="rounded-surface border border-border bg-bg-tertiary px-3.5 py-2.5 text-sm leading-relaxed text-text-primary">
        {dash ? t('welcome.greetingDashboard') : t('welcome.greeting')}
      </p>
      <div className="space-y-2">
        <p className="text-xs font-medium text-text-secondary">{t('welcome.try')}</p>
        <div className="flex flex-col gap-2">
          {keys.map((k) => {
            const q = t(`q.${k}`);
            return (
              <button key={k} type="button" dir="auto" disabled={disabled} onClick={() => onAsk(q)} className={`${pathBtn} disabled:opacity-40`}>
                {q}
              </button>
            );
          })}
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium text-text-secondary">{t('welcome.paths')}</p>
        <div className="grid gap-2">
          <button type="button" className={pathBtn} onClick={() => window.dispatchEvent(new CustomEvent(OPEN_LIVE_CHAT_EVENT, { detail: { source: 'ask-vireek' } }))}>
            <MessageCircle size={16} aria-hidden="true" />
            {t('welcome.human')}
          </button>
          <Link to={ticketHref(signedIn)} onClick={onClose} className={pathBtn}>
            <Ticket size={16} aria-hidden="true" />
            {t('welcome.ticket')}
          </Link>
          <Link to="/help" onClick={onClose} className={pathBtn}>
            <BookOpen size={16} aria-hidden="true" />
            {t('welcome.help')}
          </Link>
          {dash && (
            <button type="button" className={pathBtn} onClick={() => { onClose(); window.dispatchEvent(new CustomEvent(OPEN_ACCOUNT_ASSISTANT_EVENT)); }}>
              <Database size={16} aria-hidden="true" />
              {t('welcome.account')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
