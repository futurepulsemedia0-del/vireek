import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime, formatRelative, type DateInput } from '@/lib/format';
import { getTickerNow, subscribeTicker } from '@/lib/timeTicker';

interface RelativeTimeProps {
  value: DateInput;
  /** Switch to an absolute date once older/further than this. Default 7 days. */
  absoluteAfterMs?: number;
  className?: string;
  /** Add a tab stop so keyboard users can reach the exact-time tooltip. Default false. */
  focusable?: boolean;
}

/**
 * "5 minutes ago" that updates itself (one shared ticker) and exposes the
 * exact time on hover/focus via <time datetime title>. Renders "—" for empty values.
 */
export function RelativeTime({ value, absoluteAfterMs, className, focusable = false }: RelativeTimeProps) {
  const { i18n } = useTranslation();
  const lang = i18n.resolvedLanguage ?? i18n.language;
  const text = useSyncExternalStore(
    subscribeTicker,
    () => formatRelative(value, { now: getTickerNow(), lang, absoluteAfterMs }),
    () => formatRelative(value, { lang, absoluteAfterMs }),
  );
  const d = value === null || value === undefined || value === '' ? null : new Date(value);
  if (!d || Number.isNaN(d.getTime())) return <span className={className}>{text}</span>;
  const exact = formatDateTime(d, { dateStyle: 'full', timeStyle: 'long' }, lang);
  return (
    <time dateTime={d.toISOString()} title={exact} tabIndex={focusable ? 0 : undefined} className={className}>
      {text}
    </time>
  );
}
