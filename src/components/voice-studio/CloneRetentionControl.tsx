import { useMemo, useState } from 'react';
import { Loader2, Timer } from 'lucide-react';
import { useVoiceCloneRetentionT } from '@/i18n/voiceCloneRetentionNamespace';
import { RETENTION_PRESETS, canShorten, daysRemaining, isRetentionDue } from '../../../supabase/functions/_shared/voice-clone/retention';

const field = 'focus-ring mt-1 w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

/** Choose how long the cloned voice and its sample are kept (shown before consent is given). */
export function RetentionPicker({ value, onChange, disabled = false }: { value: number; onChange: (days: number) => void; disabled?: boolean }) {
  const { t } = useVoiceCloneRetentionT();
  return (
    <div>
      <label className="block text-start text-xs font-medium text-text-secondary">
        {t('picker.label')}
        <select value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} className={field}>
          {RETENTION_PRESETS.map((d) => <option key={d} value={d}>{t('picker.option', { days: d })}</option>)}
        </select>
      </label>
      <p className="mt-1 text-start text-xs text-text-muted">{t('picker.hint')}</p>
    </div>
  );
}

export interface RetentionSummaryProps {
  expiresAt: string | null;
  retentionDays: number;
  /** Persists the shorter period. Reject (throw) on failure. */
  onShorten: (days: number) => Promise<void>;
  now?: Date;
}

/** Shows when the voice will be deleted and lets the owner shorten (never extend) the period. */
export function RetentionSummary({ expiresAt, retentionDays, onShorten, now }: RetentionSummaryProps) {
  const { t, language } = useVoiceCloneRetentionT();
  const clock = useMemo(() => now ?? new Date(), [now]);
  const shorter = useMemo(() => RETENTION_PRESETS.filter((d) => d < retentionDays && canShorten(retentionDays, d)), [retentionDays]);
  const [pick, setPick] = useState<number | ''>('');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');

  const left = daysRemaining(expiresAt, clock);
  const due = isRetentionDue(expiresAt, clock);
  const date = expiresAt && !Number.isNaN(Date.parse(expiresAt))
    ? new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(new Date(expiresAt))
    : null;

  const save = async () => {
    if (pick === '') return;
    setState('saving');
    try { await onShorten(pick); setState('saved'); setPick(''); } catch { setState('failed'); }
  };

  return (
    <section aria-labelledby="clone-retention-h" data-testid="retention-summary" className="rounded-xl border border-border bg-bg-primary p-3 text-start">
      <h4 id="clone-retention-h" className="flex items-center gap-2 text-xs font-semibold text-text-primary"><Timer size={14} aria-hidden="true" />{t('summary.title')}</h4>
      <p className="mt-1 text-xs text-text-secondary">
        {date === null ? t('summary.unknown') : due ? t('summary.dueNow') : t('summary.expires', { date })}
        {date !== null && !due && left !== null ? <> · {t('summary.daysLeft', { days: left })}</> : null}
      </p>
      {shorter.length > 0 && !due && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="text-xs font-medium text-text-secondary">
            {t('summary.shortenLabel')}
            <select value={pick} onChange={(e) => { setPick(e.target.value === '' ? '' : Number(e.target.value)); setState('idle'); }} className={field}>
              <option value="" />
              {shorter.map((d) => <option key={d} value={d}>{t('picker.option', { days: d })}</option>)}
            </select>
          </label>
          <button type="button" onClick={save} disabled={pick === '' || state === 'saving'}
            className="focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:border-accent/40 hover:text-accent disabled:opacity-50">
            {state === 'saving' ? <><Loader2 size={14} className="animate-spin" aria-hidden="true" />{t('summary.saving')}</> : t('summary.save')}
          </button>
        </div>
      )}
      {shorter.length > 0 && !due && <p className="mt-1 text-xs text-text-muted">{t('summary.shortenHint')}</p>}
      <p role="status" aria-live="polite" className={`mt-1 text-xs ${state === 'failed' ? 'text-danger' : 'text-success'}`}>
        {state === 'saved' ? t('summary.saved') : state === 'failed' ? t('summary.failed') : ''}
      </p>
    </section>
  );
}
