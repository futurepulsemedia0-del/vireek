// Recreated: verify against original intent
import type { DiffEntry } from '@/lib/agentActions';

interface Props {
  summary: string;
  diff: DiffEntry[];
}

/** Server preview text is untrusted: every value is coerced to a bounded string and rendered as text only. */
function text(v: unknown, max = 200): string {
  if (v === null || v === undefined || v === '') return '—';
  const s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
  const out = s ?? '—';
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

export function DiffPreview({ summary, diff }: Props) {
  const rows = Array.isArray(diff) ? diff.slice(0, 40) : [];
  return (
    <div className="mt-2 rounded-lg border border-border bg-bg-tertiary/50 p-3">
      <p className="text-xs font-semibold text-text-secondary">What will change</p>
      <p className="mt-1 break-words text-sm text-text-primary">{summary}</p>
      {rows.length > 0 && (
        <ul className="mt-2 divide-y divide-border rounded-md border border-border bg-bg-secondary">
          {rows.map((d, i) => {
            const label = d.label ?? d.field;
            return (
              <li key={i} className="px-3 py-2 text-xs">
                {label !== undefined && <p className="font-medium text-text-primary">{text(label, 80)}</p>}
                <p className="break-words text-text-secondary">
                  <span className="line-through opacity-70">{text(d.before)}</span>
                  <span aria-hidden="true"> → </span>
                  <span className="sr-only"> changes to </span>
                  <span className="font-medium text-text-primary">{text(d.after)}</span>
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
