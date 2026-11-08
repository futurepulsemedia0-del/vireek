import { CircleCheck, CloudOff, ImageDown, ShieldAlert } from 'lucide-react';
import { usePhotoProvenanceT } from '@/i18n/photoProvenanceNamespace';
import type { PhotoStatus } from '@/lib/photoProvenance';

const STYLE: Record<PhotoStatus, { icon: typeof CircleCheck; cls: string }> = {
  unmodified: { icon: CircleCheck, cls: 'border-success-500/30 bg-success-500/5 text-success-500' },
  imported: { icon: ImageDown, cls: 'border-warning-500/30 bg-warning-500/5 text-warning-500' },
  offline: { icon: CloudOff, cls: 'border-warning-500/30 bg-warning-500/5 text-warning-500' },
  integrity_failed: { icon: ShieldAlert, cls: 'border-danger/30 bg-danger/5 text-danger' },
};

/** Status is conveyed by icon + text, never by colour alone (WCAG 1.4.1). */
export function PhotoStatusBadge({ status }: { status: PhotoStatus }) {
  const { t } = usePhotoProvenanceT();
  const { icon: Icon, cls } = STYLE[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${cls}`} title={t(`statusHelp.${status}`)}>
      <Icon size={12} aria-hidden="true" />
      {t(`status.${status}`)}
    </span>
  );
}
