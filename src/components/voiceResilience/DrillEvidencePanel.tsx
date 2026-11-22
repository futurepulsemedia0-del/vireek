import { AlertTriangle, CheckCircle2, ClipboardList } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import {
  MANUAL_DRILL_KINDS, MAX_NOTE, MAX_INTERVAL_DAYS, MIN_INTERVAL_DAYS, type DrillOutcome, type DrillSchedule, type DrillStatus, type EvidenceEntry, type ManualDraft, type ManualErrorKey,
} from '@/lib/voiceDrills';
import type { TFn } from '@/lib/voiceResilience';

type Msg = { tone: 'ok' | 'error'; text: string } | null;

export interface DrillEvidencePanelProps {
  t: TFn;
  schedule: DrillSchedule;
  status: DrillStatus;
  entries: EvidenceEntry[];
  formatDate: (iso: string) => string;
  onSchedule: (patch: Partial<DrillSchedule>) => void;
  onSaveSchedule: () => void;
  savingSchedule: boolean;
  scheduleMessage: Msg;
  draft: ManualDraft;
  draftError: ManualErrorKey | null;
  onDraft: (patch: Partial<ManualDraft>) => void;
  onLog: () => void;
  logging: boolean;
  logMessage: Msg;
  onGoToWizard: () => void;
}

function Message({ m }: { m: Msg }) {
  return (
    <p role={m?.tone === 'error' ? 'alert' : 'status'} aria-live={m?.tone === 'error' ? 'assertive' : 'polite'}
      className={`min-h-[1.25rem] text-sm ${m?.tone === 'error' ? 'text-danger' : 'text-text-secondary'}`}>
      {m?.text ?? ''}
    </p>
  );
}

const STATE_TONE = { ok: 'ok', due_soon: 'warn', overdue: 'critical', never: 'warn', disabled: 'warn' } as const;
const TONE_CLASS = {
  ok: 'border-success/30 bg-success-subtle text-success',
  warn: 'border-warning/30 bg-warning-subtle text-warning',
  critical: 'border-danger/30 bg-danger/10 text-danger',
} as const;

export function DrillEvidencePanel(p: DrillEvidencePanelProps) {
  const { t, schedule, status, entries } = p;
  const tone = STATE_TONE[status.state];
  const Icon = status.state === 'ok' ? CheckCircle2 : AlertTriangle;
  const body = status.state === 'ok' || status.state === 'due_soon'
    ? t(`drills.state.${status.state}.body`, { days: Math.max(0, status.daysLeft ?? 0), due: status.dueAt ? p.formatDate(status.dueAt) : '' })
    : status.state === 'overdue'
      ? t('drills.state.overdue.body', { last: status.lastPassedAt ? p.formatDate(status.lastPassedAt) : '' })
      : t(`drills.state.${status.state}.body`);
  const draftErr = p.draftError ? t(`drills.manual.errors.${p.draftError}`, { max: MAX_NOTE }) : undefined;

  return (
    <div className="space-y-5">
      <Card interactive={false} className="space-y-4 !p-6">
        <div className={`flex items-start gap-3 rounded-xl border p-4 ${TONE_CLASS[tone]}`} role="status">
          <Icon size={20} aria-hidden="true" className="mt-0.5 shrink-0" />
          <div className="space-y-1">
            <h2 className="text-base font-semibold">{t(`drills.state.${status.state}.title`)}</h2>
            <p className="text-sm">{body}</p>
          </div>
        </div>
        {status.state !== 'ok' && status.state !== 'disabled' && (
          <Button type="button" onClick={p.onGoToWizard}>{t('drills.runNow')}</Button>
        )}
        <p className="text-xs text-text-secondary">{t('drills.proofNote')}</p>
      </Card>

      <Card interactive={false} className="!p-6">
        <form className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); p.onSaveSchedule(); }}>
          <div>
            <h2 className="text-base font-semibold text-text-primary">{t('drills.schedule.title')}</h2>
            <p className="mt-1 text-sm text-text-secondary">{t('drills.schedule.intro')}</p>
          </div>
          <Checkbox label={t('drills.schedule.enabled')} checked={schedule.enabled} onChange={(e) => p.onSchedule({ enabled: e.target.checked })} />
          <Input label={t('drills.schedule.interval')} helperText={t('drills.schedule.intervalHelp', { min: MIN_INTERVAL_DAYS, max: MAX_INTERVAL_DAYS })}
            type="number" inputMode="numeric" min={MIN_INTERVAL_DAYS} max={MAX_INTERVAL_DAYS} step={1} dir="ltr"
            value={String(schedule.interval_days)} onChange={(e) => p.onSchedule({ interval_days: Number(e.target.value) })} />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={p.savingSchedule} loadingLabel={t('drills.schedule.saving')}>{t('drills.schedule.save')}</Button>
            <Message m={p.scheduleMessage} />
          </div>
        </form>
      </Card>

      <Card interactive={false} className="!p-6">
        <form className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); p.onLog(); }}>
          <div>
            <h2 className="text-base font-semibold text-text-primary">{t('drills.manual.title')}</h2>
            <p className="mt-1 text-sm text-text-secondary">{t('drills.manual.intro')}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label={t('drills.manual.kind')} value={p.draft.kind} onChange={(e) => p.onDraft({ kind: e.target.value as ManualDraft['kind'] })}>
              {MANUAL_DRILL_KINDS.map((k) => <option key={k} value={k}>{t(`drills.kind.${k}`)}</option>)}
            </Select>
            <Select label={t('drills.manual.outcome')} value={p.draft.outcome} onChange={(e) => p.onDraft({ outcome: e.target.value as DrillOutcome })}>
              <option value="passed">{t('drills.outcome.passed')}</option>
              <option value="failed">{t('drills.outcome.failed')}</option>
            </Select>
          </div>
          <Textarea label={t('drills.manual.note')} rows={3} value={p.draft.note} maxLength={MAX_NOTE + 100} error={draftErr}
            helperText={t('settings.counter', { count: p.draft.note.trim().length, max: MAX_NOTE })} onChange={(e) => p.onDraft({ note: e.target.value })} />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="secondary" loading={p.logging} loadingLabel={t('drills.manual.saving')}>{t('drills.manual.save')}</Button>
            <Message m={p.logMessage} />
          </div>
        </form>
      </Card>

      <Card interactive={false} className="space-y-3 !p-6">
        <h2 className="flex items-center gap-2 text-base font-semibold text-text-primary"><ClipboardList size={18} aria-hidden="true" /> {t('drills.log.title')}</h2>
        {entries.length === 0 ? (
          <p className="text-sm text-text-secondary">{t('drills.log.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start text-sm">
              <caption className="sr-only">{t('drills.log.title')}</caption>
              <thead>
                <tr className="text-xs text-text-secondary">
                  <th scope="col" className="py-2 pe-3 text-start font-medium">{t('drills.log.when')}</th>
                  <th scope="col" className="py-2 pe-3 text-start font-medium">{t('drills.log.what')}</th>
                  <th scope="col" className="py-2 pe-3 text-start font-medium">{t('drills.log.result')}</th>
                  <th scope="col" className="py-2 text-start font-medium">{t('drills.log.source')}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-t border-border align-top">
                    <td className="py-2 pe-3 whitespace-nowrap">{p.formatDate(e.at)}</td>
                    <td className="py-2 pe-3">
                      {t(`drills.kind.${e.kind}`)}
                      {e.note && <span className="mt-1 block text-xs text-text-secondary">{e.note}</span>}
                    </td>
                    <td className="py-2 pe-3 font-medium">{t(`drills.outcome.${e.outcome}`)}</td>
                    <td className="py-2">{t(`drills.source.${e.source}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
