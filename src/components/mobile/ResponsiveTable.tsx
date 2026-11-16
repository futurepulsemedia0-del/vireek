// src/components/mobile/ResponsiveTable.tsx — one data definition, two presentations:
//   >= md  : a real <table> (semantic, sortable-ready, keeps existing desktop density)
//   <  md  : a card list showing the 2-3 key fields, with the rest behind an expandable <details>.
// Rows may be tappable (onRowClick) and may expose actions (renderActions) in a 48px target.
import { useId, type ReactNode } from 'react';
import { useMediaQuery } from '@/hooks/useMediaQuery';

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Shown on the mobile card face. First `primary` column becomes the card title. Max ~3 per table. */
  primary?: boolean;
  /** Extra class for the desktop <td>/<th> (e.g. "text-right tabular-nums"). */
  className?: string;
}

interface Props<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  caption: string;
  emptyState?: ReactNode;
  onRowClick?: (row: T) => void;
  renderActions?: (row: T) => ReactNode;
}

export function ResponsiveTable<T>({ columns, rows, rowKey, caption, emptyState, onRowClick, renderActions }: Props<T>) {
  const isDesktop = useMediaQuery('(min-width: 768px)', true);
  const baseId = useId();

  if (rows.length === 0) return <>{emptyState ?? null}</>;

  if (isDesktop) {
    return (
      <div className="overflow-x-auto overscroll-x-contain rounded-xl border border-border">
        <table className="w-full min-w-0 text-start text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-bg-tertiary text-text-secondary">
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={`px-4 py-3 text-start font-medium ${c.className ?? ''}`}>{c.header}</th>
              ))}
              {renderActions ? <th scope="col" className="w-px px-4 py-3"><span className="sr-only">Actions</span></th> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={onRowClick ? 'cursor-pointer hover:bg-bg-tertiary' : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key} className={`px-4 py-3 align-middle ${c.className ?? ''}`}>{c.cell(row)}</td>
                ))}
                {renderActions ? <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>{renderActions(row)}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const primary = columns.filter((c) => c.primary).slice(0, 3);
  const face = primary.length > 0 ? primary : columns.slice(0, 2);
  const [title, ...subtitle] = face;
  const rest = columns.filter((c) => !face.includes(c));

  return (
    <ul aria-label={caption} className="space-y-3">
      {rows.map((row) => {
        const id = `${baseId}-${rowKey(row)}`;
        const face$ = (
          <>
            <div className="min-w-0 text-base font-medium text-text-primary [overflow-wrap:anywhere]">{title?.cell(row)}</div>
            {subtitle.map((c) => (
              <div key={c.key} className="mt-1 flex min-w-0 items-baseline justify-between gap-3 text-sm text-text-secondary">
                <span className="shrink-0">{c.header}</span>
                <span className="min-w-0 text-end text-text-primary [overflow-wrap:anywhere]">{c.cell(row)}</span>
              </div>
            ))}
          </>
        );
        return (
          <li key={rowKey(row)} className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card">
            {onRowClick ? (
              <button type="button" onClick={() => onRowClick(row)} className="focus-ring -m-1 block min-h-12 w-full touch-manipulation rounded-xl p-1 text-start active:bg-bg-tertiary">
                {face$}
              </button>
            ) : (
              <div>{face$}</div>
            )}
            {rest.length > 0 ? (
              <details className="group mt-2 border-t border-border pt-2">
                <summary className="focus-ring flex min-h-12 cursor-pointer touch-manipulation list-none items-center justify-between rounded-lg text-sm font-medium text-text-secondary [&::-webkit-details-marker]:hidden" aria-controls={id}>
                  <span>Details</span>
                  <span aria-hidden="true" className="transition-transform group-open:rotate-180 motion-reduce:transition-none">⌄</span>
                </summary>
                <dl id={id} className="space-y-2 pb-1 text-sm">
                  {rest.map((c) => (
                    <div key={c.key} className="flex justify-between gap-3">
                      <dt className="shrink-0 text-text-secondary">{c.header}</dt>
                      <dd className="min-w-0 text-end text-text-primary [overflow-wrap:anywhere]">{c.cell(row)}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            ) : null}
            {renderActions ? <div className="mt-2 flex flex-wrap gap-2 [&>*]:min-h-12">{renderActions(row)}</div> : null}
          </li>
        );
      })}
    </ul>
  );
}
