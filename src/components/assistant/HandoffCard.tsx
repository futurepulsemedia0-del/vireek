import { Link } from 'react-router-dom';
import { LifeBuoy, MessageCircle, Ticket } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useAskT } from '@/i18n/askVireekNamespace';
import { SUPPORT_HOURS_LABEL, getSupportStatus } from '@/lib/supportHours';
import { OPEN_LIVE_CHAT_EVENT, buildLiveChatDetail, ticketHref } from '@/lib/askVireek/handoff';
import type { StoredMessage } from '@/lib/askVireek/storage';

interface Props {
  messages: StoredMessage[];
  signedIn: boolean;
  lowConfidence?: boolean;
  onNavigate: () => void;
}

/** One-tap hand-off: live chat (transcript attached) or ticket/contact. Honest about support hours. */
export function HandoffCard({ messages, signedIn, lowConfidence, onNavigate }: Props) {
  const { t } = useAskT();
  const online = getSupportStatus().online;
  const openLive = () => {
    window.dispatchEvent(new CustomEvent(OPEN_LIVE_CHAT_EVENT, { detail: buildLiveChatDetail(messages) }));
  };
  return (
    <section className="space-y-2 rounded-surface border border-border bg-bg-secondary p-3" aria-label={t('handoff.title')}>
      <p className="flex items-center gap-2 text-sm font-medium text-text-primary">
        <LifeBuoy size={16} aria-hidden="true" />
        {lowConfidence ? t('handoff.lowConfidence') : t('handoff.title')}
      </p>
      <p className="text-xs text-text-secondary">{t('handoff.body')}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="xs" variant="primary" onClick={openLive}>
          <MessageCircle size={14} aria-hidden="true" />
          {online ? t('handoff.liveOnline', { hours: SUPPORT_HOURS_LABEL }) : t('handoff.liveOffline')}
        </Button>
        <Link
          to={ticketHref(signedIn)}
          onClick={onNavigate}
          className="focus-ring inline-flex min-h-touch items-center gap-1.5 rounded-control border border-border px-3 text-xs font-medium text-text-primary hover:bg-bg-tertiary"
        >
          <Ticket size={14} aria-hidden="true" />
          {signedIn ? t('handoff.ticketSignedIn') : t('handoff.ticketVisitor')}
        </Link>
      </div>
    </section>
  );
}
