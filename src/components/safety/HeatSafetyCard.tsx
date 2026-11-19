import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Droplets, Loader2, Sun, Thermometer } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { formatDateTime } from '@/lib/format';
import { HEAT_NOTICE, READING_STALE_MIN, isValidUsZip, type HeatTier } from '@/lib/safety/heat';
import {
  ackHeatEvent,
  endHeatWatch,
  fetchHeatSettings,
  fetchMyHeat,
  setHeatOptIn,
  startHeatWatch,
  type HeatSettings,
  type MyHeat,
} from '@/lib/safetyHeat';
import { SAFETY_HEAT_NS } from '@/i18n/safetyHeatNamespace';

const POLL_MS = 60_000;
const card = 'rounded-xl border border-border bg-bg-secondary p-4';
const btn = 'focus-ring min-h-[44px] rounded-lg px-4 text-sm font-semibold disabled:opacity-60';

const TIER_STYLE: Record<HeatTier, string> = {
  low: 'bg-bg-primary text-text-secondary',
  caution: 'bg-warning-subtle text-warning',
  high: 'bg-warning-subtle text-warning',
  very_high: 'bg-danger/10 text-danger',
  extreme: 'bg-danger/10 text-danger',
};

/**
 * Technician heat reminders: opt in, start for the ZIP you are working in, see the estimated heat index and the water /
 * rest reminders. Reminders are shown here only. Nothing is sent to the dispatcher, and the card never uses medical wording.
 */
export function HeatSafetyCard() {
  const { t, i18n } = useTranslation(SAFETY_HEAT_NS);
  const { toast } = useToast();
  const [settings, setSettings] = useState<HeatSettings | null>(null);
  const [live, setLive] = useState<MyHeat | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [zip, setZip] = useState('');
  const [zipTouched, setZipTouched] = useState(false);
  const lock = useRef(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const s = await fetchHeatSettings();
      const l = s.enabled && s.my_opted_in ? await fetchMyHeat() : { watch: null, events: [], alert: null };
      if (mine !== seq.current) return;
      setSettings(s);
      setLive(l);
      setError(false);
    } catch {
      if (mine === seq.current) setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { seq.current++; };
  }, [load]);

  // Refresh while a watch is running and the tab is visible.
  const watching = !!live?.watch;
  useEffect(() => {
    if (!watching) return undefined;
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL_MS);
    return () => window.clearInterval(id);
  }, [watching, load]);

  const run = async (name: string, fn: () => Promise<void>) => {
    if (lock.current) return; // double-tap guard
    lock.current = true;
    setBusy(name);
    try {
      await fn();
      await load();
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : t('errors.generic'), 'error');
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  if (error && !settings) {
    return (
      <section className={card} aria-labelledby="heat-h">
        <h2 id="heat-h" className="text-base font-semibold text-text-primary">{t('title')}</h2>
        <p role="alert" className="mt-2 text-sm text-danger">{t('load.error')} <button type="button" onClick={() => void load()} className="focus-ring font-semibold underline">{t('load.retry')}</button></p>
      </section>
    );
  }
  if (!settings) {
    return (
      <section className={card} aria-labelledby="heat-h" aria-busy="true">
        <h2 id="heat-h" className="text-base font-semibold text-text-primary">{t('title')}</h2>
        <p role="status" className="mt-2 text-sm text-text-secondary">{t('load.loading')}</p>
      </section>
    );
  }
  // Owners without a team-member record cannot opt in; nothing to show them here.
  if (!settings.is_team_member) return null;

  const zipValid = isValidUsZip(zip.trim());
  const w = live?.watch ?? null;
  const observedMs = w?.last_observed_at ? Date.parse(w.last_observed_at) : NaN;
  const stale = w && (!Number.isFinite(observedMs) || Date.now() - observedMs > READING_STALE_MIN * 60_000);
  const waiting = !!w && !w.last_checked_at;
  const fmt = (iso: string) => formatDateTime(iso, { timeStyle: 'short' }, i18n.language);

  return (
    <section className={card} aria-labelledby="heat-h">
      <h2 id="heat-h" className="flex items-center gap-2 text-base font-semibold text-text-primary"><Sun className="h-4 w-4" aria-hidden="true" />{t('title')}</h2>
      <p className="mt-1 text-xs text-text-secondary">{t('intro')}</p>

      {!settings.enabled && <p className="mt-3 text-sm text-text-secondary">{t('off')}</p>}

      {settings.enabled && (
        <label className="mt-3 flex min-h-[44px] items-start gap-3 text-sm text-text-primary">
          <input
            type="checkbox"
            className="mt-1 h-5 w-5"
            checked={settings.my_opted_in}
            disabled={busy !== null}
            onChange={(e) => void run('optin', async () => { await setHeatOptIn(e.target.checked); })}
          />
          <span>{t('optIn.label')}<span className="block text-xs text-text-secondary">{t('optIn.hint')}</span></span>
        </label>
      )}

      {settings.enabled && settings.my_opted_in && !w && (
        <form
          className="mt-3"
          onSubmit={(e) => {
            e.preventDefault();
            setZipTouched(true);
            if (!zipValid) return;
            void run('start', async () => {
              const r = await startHeatWatch(zip.trim());
              if (!r.ok) throw new Error(t(`errors.${r.error}`));
            });
          }}
        >
          <label htmlFor="heat-zip" className="mb-1 block text-xs font-semibold text-text-secondary">{t('start.zipLabel')}</label>
          <input
            id="heat-zip" inputMode="numeric" autoComplete="postal-code" maxLength={5} value={zip}
            onChange={(e) => setZip(e.target.value.replace(/\D/g, ''))}
            aria-invalid={zipTouched && !zipValid} aria-describedby="heat-zip-hint"
            className="focus-ring min-h-[44px] w-full rounded-lg border border-border bg-bg-primary px-3 text-sm text-text-primary"
          />
          <p id="heat-zip-hint" className={`mt-1 text-xs ${zipTouched && !zipValid ? 'text-danger' : 'text-text-secondary'}`}>{zipTouched && !zipValid ? t('start.zipInvalid') : t('start.zipHint')}</p>
          <button type="submit" disabled={busy !== null} className={`${btn} mt-3 w-full bg-accent text-on-accent`}>
            {busy === 'start' ? <><Loader2 className="me-2 inline h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />{t('start.starting')}</> : t('start.button')}
          </button>
        </form>
      )}

      {w && (
        <div className="mt-4 space-y-3">
          {live?.alert && <p role="status" className="rounded-lg bg-warning-subtle px-3 py-2 text-xs font-semibold text-warning">{t('live.official', { event: live.alert })}</p>}

          <div className="rounded-lg border border-border p-3">
            <p className="text-xs font-semibold text-text-secondary">{t('live.heading', { zip: w.zip })}</p>
            {waiting ? (
              <p role="status" className="mt-1 text-sm text-text-secondary">{t('live.waiting')}</p>
            ) : (
              <>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-text-primary">
                  <Thermometer className="h-4 w-4" aria-hidden="true" />
                  {w.heat_index_f !== null && <span className="font-semibold">{t('live.heatIndex', { value: Math.round(w.heat_index_f) })}</span>}
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${TIER_STYLE[w.tier]}`}>{t(`tier.${w.tier}`)}</span>
                </p>
                {w.temp_f !== null && w.rh !== null && <p className="mt-1 text-xs text-text-secondary">{t('live.details', { temp: Math.round(w.temp_f), rh: Math.round(w.rh) })}</p>}
                <p className="mt-1 text-[11px] text-text-secondary">{t('live.source')}{w.last_checked_at ? ` ${t('live.updated', { time: fmt(w.last_checked_at) })}` : ''}</p>
              </>
            )}
            {w.error && <p role="status" className="mt-2 text-xs text-warning">{t('live.weatherError')}</p>}
            {!waiting && stale && !w.error && <p role="status" className="mt-2 text-xs text-warning">{t('live.stale')}</p>}
          </div>

          <ul className="space-y-2" aria-label={t('title')}>
            {(live?.events ?? []).length === 0 && <li className="text-xs text-text-secondary">{t('prompt.none')}</li>}
            {(live?.events ?? []).map((ev) => (
              <li key={ev.id} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm text-text-primary">
                <span className="flex min-w-0 items-start gap-2">
                  <Droplets className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>
                    {ev.kind === 'water_prompt' && t('prompt.water')}
                    {ev.kind === 'rest_prompt' && t('prompt.rest')}
                    {ev.kind === 'tier_change' && t('prompt.tierChange', { tier: ev.tier ? t(`tier.${ev.tier}`) : '' })}
                    <span className="block text-[11px] text-text-secondary">{fmt(ev.created_at)}</span>
                  </span>
                </span>
                <button type="button" disabled={busy !== null} onClick={() => void run(`ack:${ev.id}`, async () => { await ackHeatEvent(ev.id); })} className={`${btn} border border-border text-text-primary`}>{t('prompt.done')}</button>
              </li>
            ))}
          </ul>

          <button type="button" disabled={busy !== null} onClick={() => void run('end', async () => { await endHeatWatch(w.id); })} className={`${btn} w-full border border-border text-text-primary`}>
            {busy === 'end' ? t('live.ending') : t('live.end')}
          </button>
          <p className="text-xs text-text-secondary">{t('incident')}</p>
        </div>
      )}

      <p className="mt-4 text-[11px] text-text-secondary">{t('notice', { defaultValue: HEAT_NOTICE })}</p>
    </section>
  );
}
