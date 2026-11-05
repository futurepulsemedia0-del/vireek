import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { fieldBase, fieldBorder } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { MASS_INCIDENT_NS } from '@/i18n/massIncidentNamespace';
import { saveSettings, setAutoReply, type SettingsRow } from '@/lib/massIncident';

const clampInt = (v: string, lo: number, hi: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

export function SettingsPanel({ value, canManage, onSaved }: { value: SettingsRow; canManage: boolean; onSaved: () => void }) {
  const { t } = useTranslation(MASS_INCIDENT_NS);
  const { toast } = useToast();
  const [draft, setDraft] = useState<SettingsRow>(value);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(value), [value]);

  const save = async () => {
    setSaving(true);
    try {
      await saveSettings(draft);
      if (draft.auto_reply_sms !== value.auto_reply_sms) await setAutoReply(draft.auto_reply_sms);
      toast(t('settingsSaved'), 'success');
      onSaved();
    } catch {
      toast(t('genericError'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const field = (id: string, label: string, v: number, lo: number, hi: number, step: number, set: (n: number) => void) => (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-text-primary">{label}</label>
      <input id={id} type="number" inputMode="decimal" min={lo} max={hi} step={step} value={v} disabled={!canManage}
        className={`${fieldBase} ${fieldBorder(false)}`} onChange={(e) => set(clampInt(e.target.value, lo, hi, v))} />
    </div>
  );

  return (
    <section aria-labelledby="settings-h" className="max-w-xl space-y-4 rounded-2xl border border-border bg-bg-secondary p-4">
      <h2 id="settings-h" className="text-base font-semibold text-text-primary">{t('settingsTitle')}</h2>
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" className="focus-ring mt-1 h-4 w-4" checked={draft.enabled} disabled={!canManage} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
        <span><span className="font-medium text-text-primary">{t('settingsEnable')}</span><br /><span className="text-text-secondary">{t('settingsEnableHelp')}</span></span>
      </label>
      <div className="grid gap-4 sm:grid-cols-3">
        {field('mi-window', t('settingsWindow'), draft.window_minutes, 15, 720, 5, (n) => setDraft({ ...draft, window_minutes: n }))}
        {field('mi-radius', t('settingsRadius'), draft.radius_miles, 1, 25, 1, (n) => setDraft({ ...draft, radius_miles: n }))}
        {field('mi-min', t('settingsMin'), draft.min_contacts, 2, 20, 1, (n) => setDraft({ ...draft, min_contacts: n }))}
      </div>
      <label className="flex items-center gap-3 text-sm text-text-primary">
        <input type="checkbox" className="focus-ring h-4 w-4" checked={draft.notify_owner} disabled={!canManage} onChange={(e) => setDraft({ ...draft, notify_owner: e.target.checked })} />
        {t('settingsNotify')}
      </label>
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" className="focus-ring mt-1 h-4 w-4" checked={draft.auto_reply_sms} disabled={!canManage} onChange={(e) => setDraft({ ...draft, auto_reply_sms: e.target.checked })} />
        <span><span className="font-medium text-text-primary">{t('settingsAutoReply')}</span><br /><span className="text-text-secondary">{t('settingsAutoReplyHelp')}</span></span>
      </label>
      <p className="text-xs text-text-secondary">{t('honestyNote')}</p>
      <p className="rounded-xl border border-warning-500/30 bg-warning-500/5 px-3 py-2 text-xs text-text-primary">{t('legalFlag')}</p>
      {canManage && <Button type="button" loading={saving} loadingLabel={t('settingsSave')} onClick={() => void save()}>{t('settingsSave')}</Button>}
    </section>
  );
}
