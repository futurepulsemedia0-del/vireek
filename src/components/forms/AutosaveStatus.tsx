import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleAlert, CloudOff, Check, Loader2 } from 'lucide-react';
import { formatRelativeTime } from '@/lib/format';
import type { AutosaveStatusValue } from '@/hooks/forms/useAutosave';

/**
 * Fixed-size status line (no layout shift). The visible text updates for every
 * state; the screen-reader region announces only settled states so typing does
 * not produce a stream of "Saving… Saved…" announcements.
 */
export function AutosaveStatus({ status, onRetry }: { status: AutosaveStatusValue; onRetry: () => void }) {
  const { t } = useTranslation('forms');
  const [, tick] = useState(0);
  useEffect(() => {
    if (status.state !== 'saved') return;
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [status.state]);

  let text = '';
  let tone = 'text-text-secondary';
  let icon = null;
  switch (status.state) {
    case 'saving':
      text = t('forms.autosave.saving', { ns: 'forms' });
      icon = <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden="true" />;
      break;
    case 'saved': {
      const recent = status.savedAt !== null && Date.now() - status.savedAt < 10_000;
      text = recent ? t('forms.autosave.savedJustNow', { ns: 'forms' }) : t('forms.autosave.saved', { ns: 'forms', when: formatRelativeTime(status.savedAt) });
      tone = 'text-success';
      icon = <Check size={14} aria-hidden="true" />;
      break;
    }
    case 'offline':
      text = t('forms.autosave.offline', { ns: 'forms' });
      tone = 'text-warning-500';
      icon = <CloudOff size={14} aria-hidden="true" />;
      break;
    case 'error':
      text = t('forms.autosave.error', { ns: 'forms' });
      tone = 'text-danger';
      icon = <CircleAlert size={14} aria-hidden="true" />;
      break;
    default:
      break;
  }
  const announce = status.state === 'saved' || status.state === 'offline' || status.state === 'error' ? text : '';

  return (
    <div className={`inline-flex min-h-[1.75rem] min-w-[16rem] items-center gap-2 whitespace-nowrap text-xs ${tone}`}>
      <span className="inline-flex w-3.5 justify-center">{icon}</span>
      <span aria-hidden="true">{text}</span>
      {status.state === 'error' && (
        <button type="button" onClick={onRetry} className="focus-ring rounded-md px-1 font-semibold underline">
          {t('forms.autosave.retry', { ns: 'forms' })}
        </button>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {announce}
      </span>
    </div>
  );
}
