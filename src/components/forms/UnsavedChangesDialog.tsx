import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import type { UnsavedChangesDialogState } from '@/hooks/forms/useUnsavedChanges';

/** Branded Save / Discard / Stay dialog. Esc and backdrop = Stay (the non-destructive choice, focused first). */
export function UnsavedChangesDialog({ open, saving, canSave, onSave, onDiscard, onStay }: UnsavedChangesDialogState) {
  const { t } = useTranslation('forms');
  const titleId = useId();
  const bodyId = useId();
  const ref = useFocusTrap(open);
  useEscapeToClose(open, onStay);
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-[110] bg-black/40" onClick={onStay} aria-hidden="true" />
      <div
        ref={ref}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="fixed left-1/2 top-1/2 z-[120] w-[92vw] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card-hover dark:shadow-card-hover-dark"
      >
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-warning-500/10 text-warning-500">
          <TriangleAlert size={20} aria-hidden="true" />
        </span>
        <h2 id={titleId} className="mt-4 text-base font-semibold text-text-primary">
          {t('forms.unsaved.title', { ns: 'forms' })}
        </h2>
        <p id={bodyId} className="mt-1.5 text-sm leading-relaxed text-text-secondary">
          {t(canSave ? 'forms.unsaved.bodyCanSave' : 'forms.unsaved.body', { ns: 'forms' })}
        </p>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" size="sm" onClick={onStay}>
            {t('forms.unsaved.stay', { ns: 'forms' })}
          </Button>
          <Button type="button" variant="ghost" size="sm" className="text-danger" onClick={onDiscard} disabled={saving}>
            {t('forms.unsaved.discard', { ns: 'forms' })}
          </Button>
          {canSave && (
            <Button type="button" size="sm" onClick={onSave} disabled={saving} aria-busy={saving}>
              {saving && <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden="true" />}
              {saving ? t('forms.unsaved.saving', { ns: 'forms' }) : t('forms.unsaved.save', { ns: 'forms' })}
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
