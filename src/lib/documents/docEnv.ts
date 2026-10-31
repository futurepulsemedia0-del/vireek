import { getPdfBrand } from '@/lib/pdfBrand';
import { formatCentsIn, getActiveRegional } from '@/lib/regional';
import { docLabels, isRtlLang, pdfLocaleTag, renderableLang } from './locale';

/**
 * Shared runtime environment for every generated document: ambient brand,
 * labels in the active language (English fallback for scripts we cannot draw
 * yet), Latin-digit locale, and money formatting on the account's currency.
 */
export async function buildDocEnv() {
  const { default: i18n } = await import('@/i18n');
  const lang = i18n.resolvedLanguage ?? i18n.language ?? 'en';
  const docLang = renderableLang(lang);
  const localeTag = pdfLocaleTag(getActiveRegional().locale);
  return {
    brand: getPdfBrand(),
    labels: docLabels(lang),
    localeTag,
    lang: docLang,
    rtl: isRtlLang(docLang),
    money: (cents: number) => formatCentsIn(cents, undefined, { locale: localeTag }),
  };
}
