// src/components/a11y/AccessibleTable.tsx
//
// یک جدول واقعاً semantic و کاملاً کیبوردی: <table> واقعی با <caption>،
// <th scope="col">، هدرهای قابل‌مرتب‌سازی که با aria-sort مشخص می‌شن و با
// Enter/Space هم کار می‌کنن (نه فقط کلیک موس)، و ارتباط ردیف/ستونی که
// screen reader واقعاً می‌تونه بخونه — پایه‌ی WCAG 1.3.1 (Info and
// Relationships)، 2.1.1 (Keyboard)، و 4.1.2 (Name, Role, Value) برای
// وضعیت sort.
import { useState, type ReactNode } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';

export interface AccessibleTableColumn<T> {
  key: string;
  header: string;
  sortable?: boolean;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
}

interface AccessibleTableProps<T> {
  caption: string;
  /** caption رو بصری مخفی می‌کنه ولی برای screen reader نگه می‌داره — وقتی یک heading دیگه بالای جدول همین رو می‌گه، true بده. */
  hideCaption?: boolean;
  columns: AccessibleTableColumn<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  emptyMessage?: string;
}

export function AccessibleTable<T>({
  caption,
  hideCaption = false,
  columns,
  rows,
  getRowKey,
  emptyMessage = 'No data to show.',
}: AccessibleTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  function toggleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const sortedRows = sortKey
    ? [...rows].sort((a, b) => {
        const col = columns.find((c) => c.key === sortKey);
        if (!col) return 0;
        const av = String(col.render(a));
        const bv = String(col.render(b));
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      })
    : rows;

  return (
    <div className="overflow-x-auto rounded-2xl border border-border">
      <table className="w-full border-collapse text-sm">
        <caption className={hideCaption ? 'sr-only' : 'px-4 py-3 text-left text-sm font-medium text-text-secondary'}>
          {caption}
        </caption>
        <thead className="border-b border-border bg-bg-tertiary">
          <tr>
            {columns.map((col) => {
              const isSorted = sortKey === col.key;
              const ariaSort = !col.sortable ? undefined : isSorted ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={ariaSort as 'ascending' | 'descending' | 'none' | undefined}
                  className={`px-4 py-3 font-semibold text-text-primary ${
                    col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left'
                  }`}
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className="focus-ring -m-1 flex items-center gap-1 rounded-lg p-1 hover:text-accent"
                    >
                      {col.header}
                      {isSorted ? (
                        sortDir === 'asc' ? (
                          <ChevronUp size={14} aria-hidden="true" />
                        ) : (
                          <ChevronDown size={14} aria-hidden="true" />
                        )
                      ) : (
                        <ChevronsUpDown size={14} aria-hidden="true" className="opacity-40" />
                      )}
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-6 text-center text-text-secondary">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            sortedRows.map((row) => (
              <tr key={getRowKey(row)} className="border-b border-border last:border-0 hover:bg-bg-tertiary/60">
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`px-4 py-3 text-text-primary ${
                      col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left'
                    }`}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
