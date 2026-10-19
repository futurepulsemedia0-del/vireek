import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

export type TourT = (key: string, defaultValue: string, vars?: Record<string, unknown>) => string;

/** i18n lookup that always falls back to the English default, so untranslated locales never show raw keys. */
export function useTourT(): TourT {
  const { t } = useTranslation('dashboard');
  return useCallback((key, defaultValue, vars) => String(t(key, { defaultValue, ...vars })), [t]);
}
