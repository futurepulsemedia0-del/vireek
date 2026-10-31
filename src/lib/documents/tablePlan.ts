/**
 * Pure pagination planner for tables with a repeating header row.
 * Rendering code measures row heights, asks for a plan, then draws it.
 */

export interface TablePlanInput {
  rowHeights: readonly number[];
  headerHeight: number;
  /** Y where the table starts on the current page. */
  startY: number;
  /** Y where content starts on a fresh page. */
  pageTopY: number;
  /** Lowest Y a row may extend to. */
  bottomY: number;
}

export interface TablePage {
  /** Index of the first row on this page (inclusive). */
  from: number;
  /** Index after the last row on this page (exclusive). */
  to: number;
  /** Y of the (repeated) header row on this page. */
  startY: number;
  /** True when the renderer must add a page before drawing this chunk. */
  newPage: boolean;
}

/**
 * Every chunk holds the header plus at least one row (even a row taller than
 * the page), so the loop always progresses and a header is never orphaned.
 */
export function planTable(input: TablePlanInput): TablePage[] {
  const { rowHeights, headerHeight, startY, pageTopY, bottomY } = input;
  const n = rowHeights.length;
  if (n === 0) return [{ from: 0, to: 0, startY, newPage: false }];

  const pages: TablePage[] = [];
  let i = 0;
  let top = startY;
  let newPage = false;
  while (i < n) {
    if (top !== pageTopY && top + headerHeight + rowHeights[i]! > bottomY) {
      top = pageTopY;
      newPage = true;
    }
    const from = i;
    let y = top + headerHeight + rowHeights[i]!;
    i++;
    while (i < n && y + rowHeights[i]! <= bottomY) {
      y += rowHeights[i]!;
      i++;
    }
    pages.push({ from, to: i, startY: top, newPage });
    top = pageTopY;
    newPage = true;
  }
  return pages;
}
