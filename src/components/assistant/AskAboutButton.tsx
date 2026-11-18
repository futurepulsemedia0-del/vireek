import { MessageCircleQuestion } from 'lucide-react';
import { useAskT } from '@/i18n/askVireekNamespace';
import { openAssistant } from '@/lib/askVireek/handoff';

interface Props {
  /** Visible topic, e.g. "Business plan". Used in the accessible name. */
  topic: string;
  /** Question to send right away. */
  question: string;
  className?: string;
}

/** Contextual "Ask about this" trigger for pricing / feature sections. Works without loading the assistant first. */
export function AskAboutButton({ topic, question, className = '' }: Props) {
  const { t } = useAskT();
  return (
    <button
      type="button"
      onClick={() => openAssistant({ ask: question })}
      aria-label={t('ask.aboutLabel', { topic })}
      className={`focus-ring inline-flex min-h-touch items-center gap-1.5 rounded-control px-2 text-sm font-medium text-accent hover:bg-bg-tertiary ${className}`}
    >
      <MessageCircleQuestion size={16} aria-hidden="true" />
      {t('ask.about')}
    </button>
  );
}
