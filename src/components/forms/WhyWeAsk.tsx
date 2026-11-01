import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleHelp } from 'lucide-react';

/** "Why we ask" disclosure for sensitive fields. Pass it as a field's `labelAction`. */
export function WhyWeAsk({ children }: { children: ReactNode }) {
  const { t } = useTranslation('forms');
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className="focus-ring inline-flex items-center gap-1 rounded-md text-xs font-medium text-accent hover:underline"
      >
        <CircleHelp size={14} aria-hidden="true" />
        {t('forms.help.whyWeAsk', { ns: 'forms' })}
      </button>
      {open && (
        <div id={panelId} className="basis-full rounded-lg border border-border bg-bg-tertiary p-3 text-xs leading-relaxed text-text-secondary">
          {children}
        </div>
      )}
    </>
  );
}
