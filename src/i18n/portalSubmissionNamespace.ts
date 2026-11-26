/* `portalSubmission` i18n namespace. English is bundled (fallback); other languages load on demand (same mechanism as revenueRealizationNamespace.ts). */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enNs from '@/locales/en/portalSubmission.json';

export const PS_NS = 'portalSubmission';
type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/portalSubmission.json', '!../locales/en/portalSubmission.json'], { import: 'default' }) as Record<string, Loader>;
if (!i18n.hasResourceBundle('en', PS_NS)) i18n.addResourceBundle('en', PS_NS, enNs, true, true);

async function load(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, PS_NS)) return;
  const loader = loaders[`../locales/${base}/portalSubmission.json`];
  if (!loader) return;
  try { instance.addResourceBundle(base, PS_NS, await loader(), true, true); } catch (err) { console.warn(`[i18n] Could not load "${PS_NS}" for "${base}"`, err); }
}
export function usePortalT() {
  const { t, i18n: instance } = useTranslation(PS_NS, { useSuspense: false });
  useEffect(() => {
    void load(instance, instance.language);
    const onChange = (lng: string) => { void load(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
