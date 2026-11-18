import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { parseMarkdown, type Block, type Inline } from '@/lib/askVireek/markdown';

function renderInline(nodes: Inline[]): ReactElement[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return <span key={i}>{n.v}</span>;
      case 'bold':
        return <strong key={i} className="font-semibold">{renderInline(n.v)}</strong>;
      case 'em':
        return <em key={i}>{renderInline(n.v)}</em>;
      case 'code':
        return <code key={i} dir="ltr" className="rounded-chip bg-bg-primary px-1 py-0.5 font-mono text-xs">{n.v}</code>;
      case 'link':
        return n.external ? (
          <a key={i} href={n.href} rel="noopener noreferrer" className="text-accent underline underline-offset-2">{renderInline(n.v)}</a>
        ) : (
          <Link key={i} to={n.href} className="text-accent underline underline-offset-2">{renderInline(n.v)}</Link>
        );
    }
  });
}

function renderBlock(b: Block, i: number): ReactElement {
  switch (b.t) {
    case 'p':
      return <p key={i} dir="auto" className="whitespace-pre-wrap break-words">{renderInline(b.v)}</p>;
    case 'ul':
      return <ul key={i} dir="auto" className="list-disc space-y-1 ps-5">{b.v.map((it, j) => <li key={j}>{renderInline(it)}</li>)}</ul>;
    case 'ol':
      return <ol key={i} dir="auto" className="list-decimal space-y-1 ps-5">{b.v.map((it, j) => <li key={j}>{renderInline(it)}</li>)}</ol>;
    case 'code':
      return (
        <pre key={i} dir="ltr" className="overflow-x-auto rounded-inset border border-border bg-bg-primary p-3 text-start font-mono text-xs">
          <code>{b.v}</code>
        </pre>
      );
  }
}

export function RichText({ text }: { text: string }) {
  return <div className="space-y-2 text-sm leading-relaxed">{parseMarkdown(text).map(renderBlock)}</div>;
}
