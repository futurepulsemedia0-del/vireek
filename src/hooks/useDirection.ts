import { useTranslation } from 'react-i18next';
import { isRTL, type LanguageCode } from '@/lib/i18n';

/** Current text direction, for the few places CSS alone can't mirror (e.g. framer-motion x offsets). */
export function useDirection(): { dir: 'ltr' | 'rtl'; isRtl: boolean } {
  const { i18n } = useTranslation();
  const base = (i18n.resolvedLanguage ?? i18n.language ?? 'en').slice(0, 2) as LanguageCode;
  const isRtl = isRTL(base);
  return { dir: isRtl ? 'rtl' : 'ltr', isRtl };
}
