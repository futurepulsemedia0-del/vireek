import { Info } from 'lucide-react';
import { usePhotoProvenanceT } from '@/i18n/photoProvenanceNamespace';

/** The honest-limits statement shown wherever provenance is displayed or shared. Never hidden behind a tooltip. */
export function HonestLimits({ className = '' }: { className?: string }) {
  const { t } = usePhotoProvenanceT();
  return (
    <section aria-labelledby="pp-limits-title" className={`rounded-lg border border-border bg-bg-secondary p-3 text-xs text-text-secondary ${className}`}>
      <h4 id="pp-limits-title" className="flex items-center gap-1.5 font-semibold text-text-primary">
        <Info size={14} aria-hidden="true" />
        {t('limits.title')}
      </h4>
      <ul className="mt-1.5 list-disc space-y-1 ps-5">
        <li>{t('limits.proves')}</li>
        <li>{t('limits.doesNot')}</li>
        <li>{t('limits.spoofing')}</li>
      </ul>
    </section>
  );
}
