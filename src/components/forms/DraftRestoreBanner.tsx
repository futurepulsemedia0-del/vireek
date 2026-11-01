import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { formatRelativeTime } from '@/lib/format';

export function DraftRestoreBanner({ savedAt, onRestore, onDiscard }: { savedAt: number; onRestore: () => void; onDiscard: () => void }) {
  const { t } = useTranslation('forms');
  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-bg-secondary p-3 text-sm text-text-primary"
    >
      <span className="min-w-0 flex-1">{t('forms.draft.prompt', { ns: 'forms', when: formatRelativeTime(savedAt) })}</span>
      <div className="flex gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDiscard}>
          {t('forms.draft.discard', { ns: 'forms' })}
        </Button>
        <Button type="button" size="sm" onClick={onRestore}>
          {t('forms.draft.restore', { ns: 'forms' })}
        </Button>
      </div>
    </div>
  );
}
