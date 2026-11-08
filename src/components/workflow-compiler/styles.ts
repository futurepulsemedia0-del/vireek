// Same classes as the buttons/fields already used by WorkflowCompilerPage, so the new panels look identical.
export const btn = 'focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-tertiary disabled:opacity-50';
export const btnPrimary = 'focus-ring inline-flex items-center gap-1.5 rounded-lg bg-accent-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-600 disabled:opacity-50';
export const field = 'focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';
export const card = 'rounded-xl border border-border bg-bg-primary p-3';

/** "next" reads as "then", branch edges as "branch N", everything else as "if <edge>". */
export function edgeText(on: string): string {
  if (on === 'next') return 'then';
  const m = /^b(\d)$/.exec(on);
  return m ? `branch ${Number(m[1]) + 1}` : `if ${on}`;
}
