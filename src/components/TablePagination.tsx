import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { pageCount } from '@/lib/tablePrefs';

interface Props {
  page: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
}

const btn =
  'focus-ring flex items-center gap-1 rounded-lg border border-border bg-bg-secondary px-3 py-1.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary disabled:cursor-not-allowed disabled:opacity-40';

export function TablePagination({ page, total, pageSize, onPage }: Props) {
  const { t } = useTranslation();
  const pages = pageCount(total, pageSize);
  if (total <= pageSize) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav aria-label={t('navflow.table.pagination', { defaultValue: 'Pagination' })} className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <p role="status" className="text-sm text-text-secondary">
        {t('navflow.table.range', { defaultValue: '{{from}}–{{to}} of {{total}}', from, to, total })}
      </p>
      <div className="flex items-center gap-2">
        <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft size={14} className="rtl:rotate-180" aria-hidden="true" /> {t('navflow.table.prev', { defaultValue: 'Previous' })}
        </button>
        <span className="text-sm text-text-secondary">{t('navflow.table.pageOf', { defaultValue: 'Page {{page}} of {{pages}}', page, pages })}</span>
        <button type="button" className={btn} disabled={page >= pages} onClick={() => onPage(page + 1)}>
          {t('navflow.table.next', { defaultValue: 'Next' })} <ChevronRight size={14} className="rtl:rotate-180" aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
