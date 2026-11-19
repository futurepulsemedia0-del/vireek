import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/contexts/ToastContext';
import { DEFAULT_HEAT_INTERVALS, HEAT_TIERS, validateIntervals, type HeatIntervals, type HeatTier } from '@/lib/safety/heat';
import { fetchHeatSettings, intervalsFromSettings, saveHeatSettings } from '@/lib/safetyHeat';
import { SAFETY_HEAT_NS } from '@/i18n/safetyHeatNamespace';

const card = 'rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5';
const field = 'focus-ring min-h-[44px] w-full rounded-lg border border-border bg-bg-primary px-3 text-sm text-text-primary';

type Draft = Record<'waterEveryMin' | 'restEveryMin', Record<HeatTier, string>>;

const toDraft = (i: HeatIntervals): Draft => ({
  waterEveryMin: Object.fromEntries(HEAT_TIERS.map((k) => [k, String(i.waterEveryMin[k])])) as Record<HeatTier, string>,
  restEveryMin: Object.fromEntries(HEAT_TIERS.map((k) => [k, String(i.restEveryMin[k])])) as Record<HeatTier, string>,
});
const fromDraft = (d: Draft): HeatIntervals => {
  const conv = (m: Record<HeatTier, string>) => Object.fromEntries(HEAT_TIERS.map((k) => [k, /^\d+$/.test(m[k].trim()) ? Number(m[k].trim()) : Number.NaN])) as Record<HeatTier, number>;
  return { waterEveryMin: conv(d.waterEveryMin), restEveryMin: conv(d.restEveryMin) };
};

/** Manager settings for heat reminders. Mount inside the Site Safety settings tab. The RPC re-checks that the caller is a manager. */
export function HeatSettingsCard() {
  const { t } = useTranslation(SAFETY_HEAT_NS);
  const { toast } = useToast();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [saved, setSaved] = useState<{ enabled: boolean; intervals: HeatIntervals } | null>(null);
  const [draft, setDraft] = useState<Draft>(toDraft(DEFAULT_HEAT_INTERVALS));
  const [saving, setSaving] = useState(false);
  const [canManage, setCanManage] = useState(true);
  const lock = useRef(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      const s = await fetchHeatSettings();
      const intervals = intervalsFromSettings(s);
      setCanManage(s.can_manage);
      setEnabled(s.enabled);
      setDraft(toDraft(intervals));
      setSaved({ enabled: s.enabled, intervals });
      setLoaded(true);
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const parsed = useMemo(() => fromDraft(draft), [draft]);
  const valid = validateIntervals(parsed);
  const dirty = !!saved && (saved.enabled !== enabled || JSON.stringify(saved.intervals) !== JSON.stringify(parsed));

  if (!canManage) return null;

  const save = async () => {
    if (lock.current || !valid) return;
    lock.current = true;
    setSaving(true);
    try {
      const s = await saveHeatSettings({ enabled, intervals: parsed });
      setSaved({ enabled: s.enabled, intervals: intervalsFromSettings(s) });
      toast(t('settings.saved'), 'success');
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : t('errors.generic'), 'error');
    } finally {
      lock.current = false;
      setSaving(false);
    }
  };

  const set = (kind: keyof Draft, tier: HeatTier, v: string) => setDraft((d) => ({ ...d, [kind]: { ...d[kind], [tier]: v.replace(/[^\d]/g, '').slice(0, 3) } }));

  const grid = (kind: keyof Draft, heading: string) => (
    <fieldset className="mt-4">
      <legend className="text-xs font-semibold text-text-secondary">{heading}</legend>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {HEAT_TIERS.map((tier) => (
          <div key={tier}>
            <label htmlFor={`heat-${kind}-${tier}`} className="mb-1 block text-xs text-text-secondary">{t(`tier.${tier}`)}</label>
            <input id={`heat-${kind}-${tier}`} inputMode="numeric" value={draft[kind][tier]} onChange={(e) => set(kind, tier, e.target.value)} aria-invalid={!valid} className={field} />
          </div>
        ))}
      </div>
    </fieldset>
  );

  return (
    <section className={card} aria-labelledby="heat-set">
      <h2 id="heat-set" className="text-base font-semibold text-text-primary">{t('settings.title')}</h2>
      <p className="mt-1 text-xs text-text-secondary">{t('settings.intro')}</p>

      {error && <p role="alert" className="mt-3 text-sm text-danger">{t('load.error')} <button type="button" onClick={() => void load()} className="focus-ring font-semibold underline">{t('load.retry')}</button></p>}
      {!loaded && !error && <p role="status" className="mt-3 text-sm text-text-secondary">{t('load.loading')}</p>}

      {loaded && (
        <>
          <label className="mt-4 flex min-h-[44px] items-start gap-3 text-sm text-text-primary">
            <input type="checkbox" className="mt-1 h-5 w-5" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>{t('settings.enable')}<span className="block text-xs text-text-secondary">{t('settings.enableHint')}</span></span>
          </label>
          {grid('waterEveryMin', t('settings.waterHeading'))}
          {grid('restEveryMin', t('settings.restHeading'))}
          {!valid && <p role="alert" className="mt-3 text-xs text-danger">{t('settings.invalid')}</p>}
          <p className="mt-3 text-[11px] text-text-secondary">{t('settings.defaultsNote')}</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button type="button" disabled={!dirty || !valid || saving} onClick={() => void save()} className="focus-ring min-h-[44px] rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent disabled:opacity-50">{saving ? t('settings.saving') : t('settings.save')}</button>
            <button type="button" disabled={saving} onClick={() => setDraft(toDraft(DEFAULT_HEAT_INTERVALS))} className="focus-ring min-h-[44px] rounded-lg border border-border px-4 text-sm font-semibold text-text-primary disabled:opacity-60">{t('settings.reset')}</button>
          </div>
        </>
      )}
    </section>
  );
}
