import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  formatCompact,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatList,
  type ListType,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatTime,
  resolveLocale,
} from '@/lib/format';

/**
 * Locale-bound formatters. Re-computes when the language changes, so any
 * component using it re-renders with the new locale automatically.
 *
 *   const f = useFormat();
 *   f.currency(1250, 'USD')  // "$1,250.00" | "‎$۱٬۲۵۰٫۰۰" (fa)
 *   f.date(job.created_at)   // "Oct 11, 2026" | "۱۱ اکتبر ۲۰۲۶" (fa)
 */
export function useFormat() {
  const { i18n } = useTranslation();
  const lang = i18n.resolvedLanguage ?? i18n.language;

  return useMemo(
    () => ({
      locale: resolveLocale(lang),
      number: (v: number | null | undefined, o?: Intl.NumberFormatOptions) => formatNumber(v, o, lang),
      percent: (v: number | null | undefined, o?: Intl.NumberFormatOptions) => formatPercent(v, o, lang),
      compact: (v: number | null | undefined) => formatCompact(v, lang),
      currency: (v: number | null | undefined, code = 'USD', o?: Intl.NumberFormatOptions) =>
        formatCurrency(v, code, o, lang),
      date: (v: Parameters<typeof formatDate>[0], s?: Parameters<typeof formatDate>[1]) => formatDate(v, s, lang),
      time: (v: Parameters<typeof formatTime>[0], o?: Intl.DateTimeFormatOptions) => formatTime(v, o, lang),
      dateTime: (v: Parameters<typeof formatDateTime>[0], o?: Intl.DateTimeFormatOptions) =>
        formatDateTime(v, o, lang),
      relative: (v: Parameters<typeof formatRelativeTime>[0], now?: number) => formatRelativeTime(v, now, lang),
      list: (items: string[], type?: ListType) => formatList(items, type, lang),
    }),
    [lang],
  );
}
