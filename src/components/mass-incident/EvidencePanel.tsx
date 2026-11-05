import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CloudLightning, FileText } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { fieldBase, fieldBorder } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { MASS_INCIDENT_NS } from '@/i18n/massIncidentNamespace';
import {
  addNotice,
  isDirectoryEntryUsable,
  retireDirectoryEntry,
  upsertDirectoryEntry,
  type DirectoryRow,
  type DirectoryService,
  type SignalRow,
  type SuspectedCause,
} from '@/lib/massIncident';

const SERVICES: DirectoryService[] = ['water', 'power', 'gas', 'sewer', 'municipal_info'];
const CAUSES: SuspectedCause[] = ['water_supply_issue', 'power_grid_outage', 'gas_utility_issue', 'severe_weather', 'sewer_main_issue', 'extreme_temperature'];
const isHttps = (v: string) => /^https:\/\/\S+$/i.test(v.trim());
const isE164 = (v: string) => /^\+[1-9]\d{6,14}$/.test(v.trim());
const today = () => new Date().toISOString().slice(0, 10);

interface Props {
  signals: SignalRow[];
  directory: DirectoryRow[];
  canManage: boolean;
  ownerId: string | null;
  onChanged: () => void;
}

export function EvidencePanel({ signals, directory, canManage, ownerId, onChanged }: Props) {
  const { t, i18n } = useTranslation(MASS_INCIDENT_NS);
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  // ---- notice form ----
  const [nHeadline, setNHeadline] = useState('');
  const [nArea, setNArea] = useState('');
  const [nZips, setNZips] = useState('');
  const [nUrl, setNUrl] = useState('');
  const [nCause, setNCause] = useState<SuspectedCause>('water_supply_issue');
  const [nTried, setNTried] = useState(false);

  const noticeValid = nHeadline.trim().length > 0 && isHttps(nUrl);
  const saveNotice = async () => {
    setNTried(true);
    if (!noticeValid) return;
    setBusy(true);
    try {
      const zips = nZips.split(',').map((z) => z.trim().toUpperCase()).filter(Boolean).slice(0, 25);
      await addNotice({ kind: 'municipal_notice', headline: nHeadline.trim(), areaDesc: nArea.trim(), postalCodes: zips, sourceUrl: nUrl.trim(), corroborates: [nCause], expiresAt: null });
      toast(t('noticeSaved'), 'success');
      setNHeadline(''); setNArea(''); setNZips(''); setNUrl(''); setNTried(false);
      onChanged();
    } catch {
      toast(t('genericError'), 'error');
    } finally {
      setBusy(false);
    }
  };

  // ---- directory form ----
  const [dService, setDService] = useState<DirectoryService>('water');
  const [dName, setDName] = useState('');
  const [dPhone, setDPhone] = useState('');
  const [dWebsite, setDWebsite] = useState('');
  const [dCountry, setDCountry] = useState('US');
  const [dRegion, setDRegion] = useState('');
  const [dPrefix, setDPrefix] = useState('');
  const [dSource, setDSource] = useState('');
  const [dDate, setDDate] = useState(today());
  const [dBy, setDBy] = useState('');
  const [dNotes, setDNotes] = useState('');
  const [dTried, setDTried] = useState(false);

  const dirValid =
    dName.trim().length > 0 && /^[A-Za-z]{2}$/.test(dCountry.trim()) && isHttps(dSource) && dBy.trim().length > 0 && dDate <= today() &&
    (dPhone.trim() === '' || isE164(dPhone)) && (dWebsite.trim() === '' || isHttps(dWebsite)) && (dPhone.trim() !== '' || dWebsite.trim() !== '');

  const saveDirectory = async () => {
    setDTried(true);
    if (!dirValid) return;
    setBusy(true);
    try {
      await upsertDirectoryEntry({
        id: null, country: dCountry.trim(), region: dRegion.trim(), postalPrefix: dPrefix.trim(), service: dService, name: dName.trim(), phone: dPhone.trim(),
        website: dWebsite.trim(), sourceUrl: dSource.trim(), verifiedAt: new Date(`${dDate}T12:00:00Z`).toISOString(), verifiedBy: dBy.trim(), notes: dNotes.trim(),
      });
      toast(t('dirSaved'), 'success');
      setDName(''); setDPhone(''); setDWebsite(''); setDRegion(''); setDPrefix(''); setDSource(''); setDNotes(''); setDTried(false);
      onChanged();
    } catch {
      toast(t('genericError'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const retire = async (id: string) => {
    setBusy(true);
    try {
      await retireDirectoryEntry(id);
      onChanged();
    } catch {
      toast(t('genericError'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const err = (show: boolean, ok: boolean) => (show && !ok ? fieldBorder(true) : fieldBorder(false));
  const now = new Date();

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section aria-labelledby="ev-h" className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-4">
        <div>
          <h2 id="ev-h" className="text-base font-semibold text-text-primary">{t('evidenceTitle')}</h2>
          <p className="mt-1 text-xs text-text-secondary">{t('evidenceHelp')}</p>
        </div>
        {signals.length === 0 ? (
          <EmptyState icon={CloudLightning} title={t('noSignals')} />
        ) : (
          <ul className="space-y-2">
            {signals.map((s) => (
              <li key={s.id} className="rounded-xl border border-border bg-bg-primary p-3 text-sm">
                <p className="flex items-center gap-2 font-medium text-text-primary">
                  {s.kind === 'weather_alert' ? <CloudLightning size={14} aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />}
                  {s.kind === 'weather_alert' ? t('signalWeather') : t('signalNotice')}
                </p>
                <p className="mt-1 text-text-primary" dir="auto">{s.headline}</p>
                {s.postal_codes.length > 0 && <p className="text-xs text-text-secondary">{s.postal_codes.join(', ')}</p>}
                {s.source_url && <a className="focus-ring text-xs text-accent underline" href={s.source_url} target="_blank" rel="noopener noreferrer">{s.source_url}</a>}
              </li>
            ))}
          </ul>
        )}

        {canManage && (
          <form className="space-y-3 border-t border-border pt-4" noValidate onSubmit={(e) => { e.preventDefault(); void saveNotice(); }}>
            <h3 className="text-sm font-semibold text-text-primary">{t('addNotice')}</h3>
            <div>
              <label htmlFor="n-headline" className="mb-1 block text-sm text-text-primary">{t('noticeHeadline')}</label>
              <input id="n-headline" className={`${fieldBase} ${err(nTried, nHeadline.trim().length > 0)}`} maxLength={300} value={nHeadline} onChange={(e) => setNHeadline(e.target.value)} aria-invalid={nTried && nHeadline.trim().length === 0} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="n-area" className="mb-1 block text-sm text-text-primary">{t('noticeArea')}</label>
                <input id="n-area" className={`${fieldBase} ${fieldBorder(false)}`} maxLength={500} value={nArea} onChange={(e) => setNArea(e.target.value)} />
              </div>
              <div>
                <label htmlFor="n-zips" className="mb-1 block text-sm text-text-primary">{t('noticeZips')}</label>
                <input id="n-zips" dir="ltr" className={`${fieldBase} ${fieldBorder(false)}`} value={nZips} onChange={(e) => setNZips(e.target.value)} />
              </div>
            </div>
            <div>
              <label htmlFor="n-url" className="mb-1 block text-sm text-text-primary">{t('noticeUrl')}</label>
              <input id="n-url" dir="ltr" type="url" className={`${fieldBase} ${err(nTried, isHttps(nUrl))}`} value={nUrl} onChange={(e) => setNUrl(e.target.value)} aria-invalid={nTried && !isHttps(nUrl)} aria-describedby="n-url-help" />
              <p id="n-url-help" className="mt-1 text-xs text-text-secondary">{t('noticeUrlHelp')}</p>
            </div>
            <div>
              <label htmlFor="n-cause" className="mb-1 block text-sm text-text-primary">{t('noticeCorroborates')}</label>
              <select id="n-cause" className={`${fieldBase} ${fieldBorder(false)}`} value={nCause} onChange={(e) => setNCause(e.target.value as SuspectedCause)}>
                {CAUSES.map((c) => <option key={c} value={c}>{t(`cause_${c}`)}</option>)}
              </select>
            </div>
            <Button type="submit" size="sm" loading={busy} loadingLabel={t('noticeSave')}>{t('noticeSave')}</Button>
          </form>
        )}
      </section>

      <section aria-labelledby="dir-h" className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-4">
        <div>
          <h2 id="dir-h" className="text-base font-semibold text-text-primary">{t('directoryTitle')}</h2>
          <p className="mt-1 text-xs text-text-secondary">{t('directoryHelp')}</p>
        </div>
        {directory.length === 0 ? (
          <EmptyState icon={FileText} title={t('directoryEmpty')} />
        ) : (
          <ul className="space-y-2">
            {directory.map((d) => {
              const usable = isDirectoryEntryUsable(
                { id: d.id, userId: d.user_id, country: d.country, region: d.region, postalPrefix: d.postal_prefix, service: d.service, name: d.name, phone: d.phone, website: d.website, sourceUrl: d.source_url, verifiedAt: d.verified_at, status: d.status },
                now,
              );
              return (
                <li key={d.id} className="rounded-xl border border-border bg-bg-primary p-3 text-sm">
                  <p className="font-medium text-text-primary">{d.name} · {t(`svc_${d.service}`)} · {d.country}{d.region ? `-${d.region}` : ''}</p>
                  <p className="text-text-secondary" dir="ltr">{[d.phone, d.website].filter(Boolean).join(' · ')}</p>
                  <p className="text-xs text-text-secondary">
                    {usable ? t('dirVerified', { date: new Date(d.verified_at).toLocaleDateString(i18n.language) }) : t('dirStale')} · {d.user_id ? t('dirYours') : t('dirPlatform')}
                  </p>
                  {canManage && d.user_id === ownerId && (
                    <Button type="button" size="sm" variant="ghost" className="mt-1" disabled={busy} onClick={() => void retire(d.id)}>{t('dirRetire')}</Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {canManage && (
          <form className="space-y-3 border-t border-border pt-4" noValidate onSubmit={(e) => { e.preventDefault(); void saveDirectory(); }}>
            <h3 className="text-sm font-semibold text-text-primary">{t('directoryAdd')}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="d-service" className="mb-1 block text-sm text-text-primary">{t('dirService')}</label>
                <select id="d-service" className={`${fieldBase} ${fieldBorder(false)}`} value={dService} onChange={(e) => setDService(e.target.value as DirectoryService)}>
                  {SERVICES.map((s) => <option key={s} value={s}>{t(`svc_${s}`)}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="d-name" className="mb-1 block text-sm text-text-primary">{t('dirName')}</label>
                <input id="d-name" className={`${fieldBase} ${err(dTried, dName.trim().length > 0)}`} maxLength={160} value={dName} onChange={(e) => setDName(e.target.value)} aria-invalid={dTried && dName.trim().length === 0} />
              </div>
              <div>
                <label htmlFor="d-phone" className="mb-1 block text-sm text-text-primary">{t('dirPhone')}</label>
                <input id="d-phone" dir="ltr" inputMode="tel" className={`${fieldBase} ${err(dTried, dPhone.trim() === '' || isE164(dPhone))}`} value={dPhone} onChange={(e) => setDPhone(e.target.value)} />
              </div>
              <div>
                <label htmlFor="d-web" className="mb-1 block text-sm text-text-primary">{t('dirWebsite')}</label>
                <input id="d-web" dir="ltr" type="url" className={`${fieldBase} ${err(dTried, dWebsite.trim() === '' || isHttps(dWebsite))}`} value={dWebsite} onChange={(e) => setDWebsite(e.target.value)} />
              </div>
              <div>
                <label htmlFor="d-country" className="mb-1 block text-sm text-text-primary">{t('dirCountry')}</label>
                <input id="d-country" dir="ltr" maxLength={2} className={`${fieldBase} ${err(dTried, /^[A-Za-z]{2}$/.test(dCountry.trim()))}`} value={dCountry} onChange={(e) => setDCountry(e.target.value.toUpperCase())} />
              </div>
              <div>
                <label htmlFor="d-region" className="mb-1 block text-sm text-text-primary">{t('dirRegion')}</label>
                <input id="d-region" dir="ltr" maxLength={3} className={`${fieldBase} ${fieldBorder(false)}`} value={dRegion} onChange={(e) => setDRegion(e.target.value.toUpperCase())} />
              </div>
              <div>
                <label htmlFor="d-prefix" className="mb-1 block text-sm text-text-primary">{t('dirPrefix')}</label>
                <input id="d-prefix" dir="ltr" maxLength={5} className={`${fieldBase} ${fieldBorder(false)}`} value={dPrefix} onChange={(e) => setDPrefix(e.target.value.toUpperCase())} />
              </div>
              <div>
                <label htmlFor="d-date" className="mb-1 block text-sm text-text-primary">{t('dirVerifiedAt')}</label>
                <input id="d-date" type="date" max={today()} className={`${fieldBase} ${err(dTried, dDate <= today())}`} value={dDate} onChange={(e) => setDDate(e.target.value)} />
              </div>
            </div>
            <div>
              <label htmlFor="d-source" className="mb-1 block text-sm text-text-primary">{t('dirSource')}</label>
              <input id="d-source" dir="ltr" type="url" className={`${fieldBase} ${err(dTried, isHttps(dSource))}`} value={dSource} onChange={(e) => setDSource(e.target.value)} aria-invalid={dTried && !isHttps(dSource)} />
            </div>
            <div>
              <label htmlFor="d-by" className="mb-1 block text-sm text-text-primary">{t('dirVerifiedBy')}</label>
              <input id="d-by" className={`${fieldBase} ${err(dTried, dBy.trim().length > 0)}`} maxLength={160} value={dBy} onChange={(e) => setDBy(e.target.value)} />
            </div>
            <div>
              <label htmlFor="d-notes" className="mb-1 block text-sm text-text-primary">{t('dirNotes')}</label>
              <input id="d-notes" className={`${fieldBase} ${fieldBorder(false)}`} maxLength={500} value={dNotes} onChange={(e) => setDNotes(e.target.value)} />
            </div>
            <Button type="submit" size="sm" loading={busy} loadingLabel={t('dirSave')}>{t('dirSave')}</Button>
          </form>
        )}
      </section>
    </div>
  );
}
