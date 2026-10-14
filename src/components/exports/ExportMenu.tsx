import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, FileSpreadsheet, FileText, FileType, Loader2, History } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import {
  EXPORT_DATASETS,
  EXPORT_FORMATS,
  FORMAT_LABEL,
  createExport,
  useCanExport,
  type ExportDatasetId,
  type ExportFilters,
  type ExportFormat,
} from '@/lib/dataExports';

const FORMAT_ICON: Record<ExportFormat, typeof FileText> = {
  csv: FileText,
  xlsx: FileSpreadsheet,
  pdf: FileType,
};

const FORMAT_HINT: Record<ExportFormat, string> = {
  csv: 'Universal, opens anywhere',
  xlsx: 'Formatted spreadsheet',
  pdf: 'Print-ready report',
};

interface ExportMenuProps {
  dataset: ExportDatasetId;
  /** Current table filters (status / search / date range). Optional. */
  filters?: ExportFilters;
  label?: string;
  className?: string;
}

/**
 * "Export" button for any main table. Starts an ASYNC export job on the
 * server (see /dashboard/exports for history + downloads). Renders nothing
 * for members without the export permission, so there's no dead button.
 */
export function ExportMenu({ dataset, filters, label = 'Export', className = '' }: ExportMenuProps) {
  const canExport = useCanExport();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!canExport) return null;

  const start = async (format: ExportFormat) => {
    if (busy) return;
    setBusy(format);
    try {
      await createExport({ dataset, format, filters });
      toast(
        `${EXPORT_DATASETS[dataset].label} ${FORMAT_LABEL[format]} export started. Find it in Exports when it's ready.`,
        'success',
      );
      setOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not start the export.', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="focus-ring flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary"
      >
        <Download size={15} /> {label}
      </button>

      {open && (
        <div
          role="menu"
          aria-label={`Export ${EXPORT_DATASETS[dataset].label}`}
          className="absolute right-0 z-40 mt-2 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border bg-bg-secondary p-1.5 shadow-card-hover dark:shadow-card-hover-dark"
        >
          {EXPORT_FORMATS.map((f) => {
            const Icon = FORMAT_ICON[f];
            return (
              <button
                key={f}
                type="button"
                role="menuitem"
                disabled={busy !== null}
                onClick={() => start(f)}
                className="focus-ring flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-bg-tertiary disabled:opacity-60"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                  {busy === f ? <Loader2 size={15} className="animate-spin" /> : <Icon size={15} />}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-text-primary">{FORMAT_LABEL[f]}</span>
                  <span className="block text-xs text-text-secondary">{FORMAT_HINT[f]}</span>
                </span>
              </button>
            );
          })}
          <Link
            to="/dashboard/exports"
            onClick={() => setOpen(false)}
            className="focus-ring mt-1 flex items-center gap-2 rounded-xl border-t border-border px-3 py-2.5 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary"
          >
            <History size={13} /> Export history
          </Link>
        </div>
      )}
    </div>
  );
}
