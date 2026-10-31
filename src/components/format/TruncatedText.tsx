import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LINE_CLAMP_CLASS, TEXT_LINES, type TextKind } from '@/lib/textPolicy';

interface TruncatedTextProps {
  text: string;
  /** Picks the default line count (name/email/id: 1, address: 2, note: 3). */
  kind?: TextKind;
  lines?: 1 | 2 | 3 | 4 | 5 | 6;
  /** Show a "Show more / Show less" toggle when the text is clipped. */
  expandable?: boolean;
  /** `ltr` for emails/IDs/URLs inside RTL pages; `auto` (default) follows the text. */
  dir?: 'ltr' | 'auto';
  className?: string;
}

/**
 * Policy-compliant long text: clamps to N lines, never widens its parent
 * (min-w-0), wraps long tokens, and only sets a native tooltip when text is
 * actually clipped. Expandable variant exposes aria-expanded.
 */
export function TruncatedText({ text, kind = 'name', lines, expandable = false, dir = 'auto', className = '' }: TruncatedTextProps) {
  const { t } = useTranslation('dashboard');
  const ref = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const n = lines ?? TEXT_LINES[kind];

  useEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, n, expanded]);

  return (
    <span className={`block min-w-0 ${className}`}>
      <span
        ref={ref}
        dir={dir}
        title={clipped && !expanded ? text : undefined}
        className={`block min-w-0 ${expanded ? 'whitespace-pre-wrap break-words' : LINE_CLAMP_CLASS[n]}`}
      >
        {text}
      </span>
      {expandable && (clipped || expanded) && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs font-medium text-text-secondary underline focus-ring"
        >
          {expanded ? t('format.showLess') : t('format.showMore')}
        </button>
      )}
    </span>
  );
}
