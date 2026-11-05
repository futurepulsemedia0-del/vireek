import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { LEVELS, MAX_FORWARD_NUMBERS, MAX_STATIC_MESSAGE, type Lang, type Level, type SettingsDraft, type SettingsErrors, type TFn } from '@/lib/voiceResilience';

export interface BackupSettingsPanelProps {
  t: TFn;
  draft: SettingsDraft;
  errors: SettingsErrors;
  onChange: (patch: Partial<SettingsDraft>) => void;
  onSave: () => void;
  saving: boolean;
  /** Result line for the last save: rendered in an aria-live region. */
  message: { tone: 'ok' | 'error'; text: string } | null;
  override: {
    level: Level;
    minutes: number;
    active: boolean;
    busy: boolean;
    onLevel: (l: Level) => void;
    onMinutes: (m: number) => void;
    onApply: () => void;
    onClear: () => void;
    message: { tone: 'ok' | 'error'; text: string } | null;
  };
}

function Message({ m }: { m: { tone: 'ok' | 'error'; text: string } | null }) {
  // The live region stays mounted so screen readers announce text inserted into it.
  return (
    <p role={m?.tone === 'error' ? 'alert' : 'status'} aria-live={m?.tone === 'error' ? 'assertive' : 'polite'}
      className={`min-h-[1.25rem] text-sm ${m?.tone === 'error' ? 'text-danger' : 'text-text-secondary'}`}>
      {m?.text ?? ''}
    </p>
  );
}

export function BackupSettingsPanel({ t, draft, errors, onChange, onSave, saving, message, override }: BackupSettingsPanelProps) {
  const err = (k: keyof SettingsErrors): string | undefined => {
    const e = errors[k];
    return e ? t(`settings.errors.${e.key}`, e.values) : undefined;
  };
  return (
    <div className="space-y-5">
      <Card interactive={false} className="!p-6">
        <form className="space-y-5" noValidate onSubmit={(e) => { e.preventDefault(); onSave(); }}>
          <div>
            <h2 className="text-base font-semibold text-text-primary">{t('settings.title')}</h2>
            <p className="mt-1 text-sm text-text-secondary">{t('settings.intro')}</p>
          </div>
          <Textarea label={t('settings.forwardLabel')} helperText={t('settings.forwardHelp', { max: MAX_FORWARD_NUMBERS })} rows={4}
            inputMode="tel" autoComplete="off" dir="ltr" value={draft.forwardNumbersText}
            error={err('forwardNumbers')} onChange={(e) => onChange({ forwardNumbersText: e.target.value })} />
          <Textarea label={t('settings.staticLabel')} rows={3} value={draft.staticMessage} maxLength={MAX_STATIC_MESSAGE + 100}
            helperText={`${t('settings.staticHelp')} ${t('settings.counter', { count: draft.staticMessage.trim().length, max: MAX_STATIC_MESSAGE })}`}
            error={err('staticMessage')} onChange={(e) => onChange({ staticMessage: e.target.value })} />
          <Select label={t('settings.languageLabel')} value={draft.language} onChange={(e) => onChange({ language: e.target.value as Lang })}>
            <option value="en">{t('settings.lang.en')}</option>
            <option value="es">{t('settings.lang.es')}</option>
          </Select>
          <Input label={t('settings.assistantLabel')} helperText={t('settings.assistantHelp')} dir="ltr" autoComplete="off" spellCheck={false}
            value={draft.reducedAssistantId} error={err('reducedAssistantId')} onChange={(e) => onChange({ reducedAssistantId: e.target.value })} />
          <Checkbox label={t('settings.alertSms')} helperText={t('settings.alertSmsHelp')} checked={draft.alertSms} onChange={(e) => onChange({ alertSms: e.target.checked })} />
          <Checkbox label={t('settings.frontDoor')} helperText={t('settings.frontDoorHelp')} checked={draft.frontDoorEnabled} onChange={(e) => onChange({ frontDoorEnabled: e.target.checked })} />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={saving} loadingLabel={t('settings.saving')}>{t('settings.save')}</Button>
            <Message m={message} />
          </div>
        </form>
      </Card>

      <Card interactive={false} className="!p-6">
        <form className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); override.onApply(); }}>
          <div>
            <h2 className="text-base font-semibold text-text-primary">{t('settings.override.title')}</h2>
            <p className="mt-1 text-sm text-text-secondary">{t('settings.override.help')}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label={t('settings.override.levelLabel')} value={String(override.level)} onChange={(e) => override.onLevel(Number(e.target.value) as Level)}>
              {LEVELS.map((l) => <option key={l} value={l}>{`${l} · ${t(`status.levels.${l}.name`)}`}</option>)}
            </Select>
            <Input label={t('settings.override.minutesLabel')} type="number" inputMode="numeric" min={1} max={1440} step={1} dir="ltr"
              value={String(override.minutes)} onChange={(e) => override.onMinutes(Number(e.target.value))} />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="secondary" loading={override.busy} loadingLabel={t('settings.override.applying')}>{t('settings.override.apply')}</Button>
            {override.active && <Button type="button" variant="ghost" onClick={override.onClear} disabled={override.busy}>{t('settings.override.clear')}</Button>}
            <Message m={override.message} />
          </div>
        </form>
      </Card>
    </div>
  );
}
