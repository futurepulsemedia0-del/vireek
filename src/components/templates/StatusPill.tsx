import { STATUS_LABELS, STATUS_STYLES, type TemplateStatus } from '@/lib/messageTemplates';

export function StatusPill({ status, className = '' }: { status: TemplateStatus; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLES[status]} ${className}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}
