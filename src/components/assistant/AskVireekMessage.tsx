import { Link } from 'react-router-dom';
import { ThumbsDown, ThumbsUp, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { IconButton } from '@/components/ui/IconButton';
import { StreamingCaret } from '@/components/chat/ChatVisuals';
import { useAskT } from '@/i18n/askVireekNamespace';
import type { ChatMessage } from '@/lib/askVireek/state';
import { RichText } from './RichText';

interface Props {
  message: ChatMessage;
  isLast: boolean;
  busy: boolean;
  canRetry: boolean;
  onAsk: (q: string) => void;
  onRate: (id: string, r: 1 | -1) => void;
  onRetry: () => void;
}

export function AskVireekMessage({ message: m, isLast, busy, canRetry, onAsk, onRate, onRetry }: Props) {
  const { t, language } = useAskT();
  const time = new Date(m.at).toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' });
  const user = m.role === 'user';

  return (
    <div className={`group flex flex-col gap-1.5 ${user ? 'items-end' : 'items-start'}`}>
      <span className="sr-only">{user ? t('message.you') : t('message.assistant')}</span>
      <div
        title={t('message.sentAt', { time })}
        className={`max-w-[85%] rounded-surface border px-3.5 py-2.5 text-text-primary ${
          user ? 'border-accent/20 bg-accent/10' : m.isError ? 'border-danger bg-bg-secondary' : 'border-border bg-bg-tertiary'
        }`}
      >
        <RichText text={m.text} />
        {m.streaming && <StreamingCaret />}
      </div>
      <time dateTime={new Date(m.at).toISOString()} className="px-1 text-xs text-text-muted opacity-0 transition-opacity duration-base group-hover:opacity-100 group-focus-within:opacity-100">
        {time}
      </time>

      {!user && !m.streaming && !m.isError && (
        <div className="flex flex-wrap items-center gap-1">
          <CopyButton text={m.text} label={t('message.copy')} copiedLabel={t('message.copied')} variant="ghost" size="xs" />
          {m.answerId && (
            <>
              <IconButton label={t('message.helpful')} icon={ThumbsUp} size="xs" aria-pressed={m.rating === 1} disabled={!!m.rating} onClick={() => onRate(m.id, 1)} />
              <IconButton label={t('message.notHelpful')} icon={ThumbsDown} size="xs" aria-pressed={m.rating === -1} disabled={!!m.rating} onClick={() => onRate(m.id, -1)} />
            </>
          )}
          {m.rating && <span className="text-xs text-text-secondary" role="status">{t('message.thanks')}</span>}
        </div>
      )}

      {!user && m.isError && canRetry && isLast && (
        <Button type="button" size="xs" variant="secondary" onClick={onRetry}>
          <RotateCcw size={14} aria-hidden="true" />
          {t('message.retry')}
        </Button>
      )}

      {!user && !m.streaming && m.sources && m.sources.length > 0 && (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-text-secondary">
          <span className="font-medium">{t('message.sources')}</span>
          {m.sources.map((s) => (
            <Link key={s.url} to={s.url} className="focus-ring rounded-chip border border-border bg-bg-secondary px-2 py-0.5 text-accent hover:bg-bg-tertiary">
              {s.title}
            </Link>
          ))}
        </p>
      )}

      {!user && isLast && !m.streaming && !m.isError && m.suggestions && m.suggestions.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('message.followUps')}>
          {m.suggestions.map((s) => (
            <button key={s} type="button" disabled={busy} onClick={() => onAsk(s)} className="focus-ring rounded-chip border border-border bg-bg-secondary px-3 py-1 text-start text-xs text-text-primary hover:border-accent disabled:opacity-40">
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
