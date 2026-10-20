import { Fragment } from 'react';
import {
  JobSopStatus,
  MdInline,
  TRAINING_STATUS_META,
  jobSopStatusLabel,
  parseMarkdown,
} from '@/lib/sop';

const toneClass = {
  success: 'bg-success/10 text-success',
  danger: 'bg-danger/10 text-danger',
  warning: 'bg-warning-500/10 text-warning-500',
  info: 'bg-accent/10 text-accent',
  neutral: 'bg-bg-tertiary text-text-secondary',
} as const;

export function StatusBadge({ status }: { status: JobSopStatus }) {
  const tone = status === 'reference' ? 'neutral' : TRAINING_STATUS_META[status].tone;
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${toneClass[tone]}`}>
      {jobSopStatusLabel(status)}
    </span>
  );
}

export function ProgressBar({ pct, label }: { pct: number; label: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      aria-label={label}
      className="h-2 w-full overflow-hidden rounded-full bg-bg-tertiary"
    >
      <div className="h-full rounded-full bg-success transition-[width] duration-300" style={{ width: `${clamped}%` }} />
    </div>
  );
}

function Inline({ nodes }: { nodes: MdInline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.type) {
          case 'bold':
            return <strong key={i} className="font-semibold text-text-primary">{n.text}</strong>;
          case 'code':
            return <code key={i} className="rounded bg-bg-tertiary px-1.5 py-0.5 text-[0.9em]">{n.text}</code>;
          case 'link':
            return (
              <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow" className="text-accent underline underline-offset-2">
                {n.text}
              </a>
            );
          default:
            return <Fragment key={i}>{n.text}</Fragment>;
        }
      })}
    </>
  );
}

/** Renders SOP markdown as real React nodes — never as HTML — so authored text cannot inject script. */
export function SopMarkdown({ source }: { source: string }) {
  const blocks = parseMarkdown(source);
  return (
    <div className="space-y-4 text-sm leading-relaxed text-text-secondary">
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'heading': {
            const cls = b.level === 1 ? 'text-xl font-bold' : b.level === 2 ? 'text-lg font-semibold' : 'text-base font-semibold';
            const Tag = (`h${b.level + 1}`) as 'h2' | 'h3' | 'h4';
            return <Tag key={i} className={`${cls} text-text-primary`}><Inline nodes={b.inline} /></Tag>;
          }
          case 'paragraph':
            return <p key={i}><Inline nodes={b.inline} /></p>;
          case 'ul':
            return <ul key={i} className="list-disc space-y-1.5 pl-5">{b.items.map((it, j) => <li key={j}><Inline nodes={it} /></li>)}</ul>;
          case 'ol':
            return <ol key={i} className="list-decimal space-y-1.5 pl-5">{b.items.map((it, j) => <li key={j}><Inline nodes={it} /></li>)}</ol>;
          case 'check':
            return (
              <ul key={i} className="space-y-1.5">
                {b.items.map((it, j) => (
                  <li key={j} className="flex items-start gap-2">
                    <span aria-hidden="true" className="mt-0.5">{it.checked ? '☑' : '☐'}</span>
                    <span><Inline nodes={it.inline} /></span>
                  </li>
                ))}
              </ul>
            );
        }
      })}
    </div>
  );
}
