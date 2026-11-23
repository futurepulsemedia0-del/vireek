/* `incidentComms` i18n namespace for /staff/incident-comms. English is bundled; other languages are lazy chunks. */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import i18n from '@/i18n';
import enIncidentComms from '@/locales/en/incidentComms.json';

export const INCIDENT_COMMS_NS = 'incidentComms';

type Loader = () => Promise<Record<string, unknown>>;
const loaders = import.meta.glob(['../locales/*/incidentComms.json', '!../locales/en/incidentComms.json'], { import: 'default' }) as Record<string, Loader>;

if (!i18n.hasResourceBundle('en', INCIDENT_COMMS_NS)) {
  i18n.addResourceBundle('en', INCIDENT_COMMS_NS, enIncidentComms, true, true);
}

async function loadLocale(instance: I18n, lng: string | undefined): Promise<void> {
  const base = (lng ?? '').slice(0, 2).toLowerCase();
  if (!base || base === 'en' || instance.hasResourceBundle(base, INCIDENT_COMMS_NS)) return;
  const loader = loaders[`../locales/${base}/incidentComms.json`];
  if (!loader) return;
  try {
    instance.addResourceBundle(base, INCIDENT_COMMS_NS, await loader(), true, true);
  } catch (err) {
    console.warn(`[i18n] Could not load "${INCIDENT_COMMS_NS}" for "${base}"`, err);
  }
}

export function useIncidentCommsT() {
  const { t, i18n: instance } = useTranslation(INCIDENT_COMMS_NS, { useSuspense: false });
  useEffect(() => {
    void loadLocale(instance, instance.language);
    const onChange = (lng: string) => { void loadLocale(instance, lng); };
    instance.on('languageChanged', onChange);
    return () => { instance.off('languageChanged', onChange); };
  }, [instance]);
  return { t, language: instance.language || 'en' };
}
