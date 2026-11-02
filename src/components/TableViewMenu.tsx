import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { DENSITIES, PAGE_SIZES, type ColumnDef, type Density } from '@/lib/tablePrefs';
import type { PrefsSync } from '@/hooks/useTablePrefs';

interface Props {
  ordered: readonly ColumnDef[];
  visibleKeys: readonly string[];
  density: Density;
  pageSize: number;
  sync: PrefsSync;
  onToggleColumn: (key: string) => void;
  onMove: (key: string, dir: -1 | 1) => void;
  onDensity: (d: Density) => void;
  onPageSize: (n: number) => void;
  onReset: () => void;
}

const chip = 'focus-ring rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors';

/** One popover for the whole per-user table state: columns (show/hide/reorder), density, rows per page. */
export function TableViewMenu(p: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const syncText: Record<PrefsSync, string> = {
    local: t('navflow.table.syncLocal', { defaultValue: 'Saved on this device' }),
    syncing: t('navflow.table.syncSyncing', { defaultValue: 'Saving…' }),
    synced: t('navflow.table.syncSynced', { defaultValue: 'Saved to your account' }),
    error: t('navflow.table.syncError', { defaultValue: 'Saved on this device (sync failed)' }),
  };
  const densityLabel: Record<Density, string> = {
    compact: t('navflow.table.compact', { defaultValue: 'Compact' }),
    comfortable: t('navflow.table.comfortable', { defaultValue: 'Comfortable' }),
    spacious: t('navflow.table.spacious', { defaultValue: 'Spacious' }),
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="focus-ring flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary"
      >
        <SlidersHorizontal size={15} aria-hidden="true" /> {t('navflow.table.view', { defaultValue: 'View' })}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t('navflow.table.viewOptions', { defaultValue: 'Table view options' })}
          className="absolute end-0 top-full z-20 mt-2 w-72 max-w-[90vw] rounded-xl border border-border bg-bg-secondary p-3 shadow-card-hover dark:shadow-card-hover-dark"
        >
          <fieldset>
            <legend className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
              {t('navflow.table.columns', { defaultValue: 'Columns' })}
            </legend>
            <ul className="mt-2 space-y-1">
              {p.ordered.map((c, i) => (
                <li key={c.key} className="flex items-center gap-1">
                  <label className="flex flex-1 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-text-primary hover:bg-bg-tertiary">
                    <input
                      type="checkbox"
                      checked={c.required || p.visibleKeys.includes(c.key)}
                      disabled={c.required}
                      onChange={() => p.onToggleColumn(c.key)}
                    />
                    {c.label}
                  </label>
                  <button
                    type="button"
                    disabled={i === 0}
                    onClick={() => p.onMove(c.key, -1)}
                    aria-label={t('navflow.table.moveUp', { defaultValue: 'Move {{name}} up', name: c.label })}
                    className="focus-ring rounded p-1 text-text-secondary hover:text-text-primary disabled:opacity-30"
                  >
                    <ArrowUp size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    disabled={i === p.ordered.length - 1}
                    onClick={() => p.onMove(c.key, 1)}
                    aria-label={t('navflow.table.moveDown', { defaultValue: 'Move {{name}} down', name: c.label })}
                    className="focus-ring rounded p-1 text-text-secondary hover:text-text-primary disabled:opacity-30"
                  >
                    <ArrowDown size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </fieldset>

          <fieldset className="mt-3">
            <legend className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
              {t('navflow.table.density', { defaultValue: 'Density' })}
            </legend>
            <div className="mt-2 flex flex-wrap gap-1.5" role="radiogroup">
              {DENSITIES.map((d) => (
                <button
                  key={d}
                  type="button"
                  role="radio"
                  aria-checked={p.density === d}
                  onClick={() => p.onDensity(d)}
                  className={`${chip} ${p.density === d ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}
                >
                  {densityLabel[d]}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="mt-3 block text-xs font-semibold uppercase tracking-wide text-text-secondary">
            {t('navflow.table.pageSize', { defaultValue: 'Rows per page' })}
            <select
              value={p.pageSize}
              onChange={(e) => p.onPageSize(Number(e.target.value))}
              className="focus-ring mt-1 w-full rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-sm font-normal normal-case tracking-normal text-text-primary"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>

          <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
            <span role="status" className="text-xs text-text-secondary">
              {syncText[p.sync]}
            </span>
            <button
              type="button"
              onClick={p.onReset}
              className="focus-ring flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-text-secondary hover:text-text-primary"
            >
              <RotateCcw size={12} aria-hidden="true" /> {t('navflow.table.reset', { defaultValue: 'Reset' })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
