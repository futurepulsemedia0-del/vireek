const MAX_CELL = 40;

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_CELL ? `${flat.slice(0, MAX_CELL - 1)}…` : flat;
}

/** Plain-text table: header, rule, rows. No colors, so it is safe in logs and CI. */
export function renderTable(rows: readonly Record<string, unknown>[], columns: readonly string[]): string {
  if (rows.length === 0) return '(no results)';
  const matrix = rows.map((row) => columns.map((column) => cell(row[column])));
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...matrix.map((line) => (line[index] as string).length)),
  );
  const line = (parts: readonly string[]) => parts.map((part, index) => part.padEnd(widths[index] as number)).join('  ').trimEnd();
  return [line(columns), line(widths.map((width) => '-'.repeat(width))), ...matrix.map(line)].join('\n');
}
