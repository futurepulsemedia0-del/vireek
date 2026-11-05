import { useEffect, useState } from 'react';
import { ShieldCheck, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { useAutopilotT } from '@/i18n/autopilotNamespace';
import { saveSettings, type AutopilotSettings, type AutopilotModeSetting } from '@/lib/voiceAutopilot';

const MODES: AutopilotModeSetting[] = ['off', 'suggest', 'auto'];
const MODE_KEY: Record<AutopilotModeSetting, string> = { off: 'settings.modeOff', suggest: 'settings.modeSuggest', auto: 'settings.modeAuto' };
const TRAFFIC = [5, 10, 20, 30, 50];

interface Props {
  settings: AutopilotSettings;
  onSaved: (s: AutopilotSettings) => void;
  onToast: (message: string, kind: 'success' | 'error') => void;
}

export function AutopilotSettingsCard({ settings, onSaved, onToast }: Props) {
  const { t } = useAutopilotT();
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(settings), [settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const save = async () => {
    setSaving(true);
    try {
      onSaved(await saveSettings(draft));
      onToast(t('settings.saved'), 'success');
    } catch {
      onToast(t('settings.saveFailed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="autopilot-settings-title" className="rounded-2xl border border-border bg-bg-secondary p-5">
      <h3 id="autopilot-settings-title" className="flex items-center gap-2 text-base font-semibold text-text-primary">
        <ShieldCheck size={18} aria-hidden="true" className="text-accent" />
        {t('settings.title')}
      </h3>
      <p className="mt-1 text-sm text-text-secondary">{t('settings.intro')}</p>

      <p className="mt-3 rounded-xl border border-border bg-bg-tertiary px-3 py-2 text-xs text-text-secondary" role="note">
        <strong className="text-text-primary">{t('locked.title')}.</strong> {t('locked.body')}
      </p>

      <fieldset className="mt-4">
        <legend className="mb-1.5 text-sm font-medium text-text-primary">{t('settings.mode')}</legend>
        <div className="space-y-2">
          {MODES.map((m) => (
            <label key={m} className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-xl border border-border bg-bg-primary px-3 text-sm text-text-primary has-[:checked]:border-accent has-[:checked]:bg-accent/5">
              <input type="radio" name="autopilot-mode" value={m} checked={draft.mode === m} onChange={() => setDraft({ ...draft, mode: m })} className="focus-ring h-4 w-4" />
              {t(MODE_KEY[m])}
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-text-secondary">{t('settings.modeNote')}</p>
      </fieldset>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="ap-max-traffic" className="mb-1.5 block text-sm font-medium text-text-primary">{t('settings.maxTraffic')}</label>
          <select id="ap-max-traffic" value={draft.max_traffic_pct} onChange={(e) => setDraft({ ...draft, max_traffic_pct: Number(e.target.value) })} className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary">
            {TRAFFIC.map((p) => (<option key={p} value={p}>{p}%</option>))}
          </select>
        </div>
        <div>
          <label htmlFor="ap-max-auto" className="mb-1.5 block text-sm font-medium text-text-primary">{t('settings.maxAuto')}</label>
          <select id="ap-max-auto" value={draft.max_auto_promotions_per_week} disabled={draft.mode !== 'auto'} onChange={(e) => setDraft({ ...draft, max_auto_promotions_per_week: Number(e.target.value) })} className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary disabled:opacity-50">
            {[0, 1, 2, 3, 5, 7].map((n) => (<option key={n} value={n}>{n}</option>))}
          </select>
          <p className="mt-1 text-xs text-text-secondary">{t('settings.autoNote')}</p>
        </div>
      </div>

      <div className="mt-4">
        <Switch checked={draft.pooled_priors_opt_in} onChange={(v) => setDraft({ ...draft, pooled_priors_opt_in: v })} label={t('settings.pooled')} hint={t('settings.pooledHint')} />
      </div>

      <div className="mt-5 flex justify-end">
        <Button type="button" onClick={save} disabled={!dirty || saving}>
          {saving ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
          {saving ? t('common.saving') : t('common.save')}
        </Button>
      </div>
    </section>
  );
}
