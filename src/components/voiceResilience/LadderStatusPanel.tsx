import { AlertTriangle, CheckCircle2, PhoneForwarded, RefreshCw, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { LEVELS, OUTCOME_KEY, effectiveLevelFor, levelTone, type Level, type TFn, type Tone, type VoiceStatus } from '@/lib/voiceResilience';

const TONE_CLASS: Record<Tone, string> = {
  ok: 'border-success-500/30 bg-success-500/10 text-success-500',
  warn: 'border-warning-500/30 bg-warning-500/10 text-warning-500',
  critical: 'border-danger/30 bg-danger/10 text-danger',
};
const TONE_ICON = { ok: CheckCircle2, warn: AlertTriangle, critical: ShieldAlert } as const;

export interface LadderStatusPanelProps {
  t: TFn;
  status: VoiceStatus;
  now: number;
  refreshing?: boolean;
  onRefresh: () => void;
  formatDate: (iso: string) => string;
}

/** Level badge always carries text (WCAG 1.4.1); colour is reinforcement only. */
export function LevelBadge({ t, level }: { t: TFn; level: Level }) {
  const tone = levelTone(level);
  const Icon = TONE_ICON[tone];
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-semibold ${TONE_CLASS[tone]}`}>
      <Icon size={16} aria-hidden="true" />
      <span>{t('status.levelLabel', { level })}</span>
      <span aria-hidden="true">·</span>
      <span>{t(`status.tone.${tone}`)}</span>
    </span>
  );
}

export function LadderStatusPanel({ t, status, now, refreshing = false, onRefresh, formatDate }: LadderStatusPanelProps) {
  const { level, pinned } = effectiveLevelFor(status, now);
  const calls = status.recent_fallback_calls;

  return (
    <div className="space-y-5">
      <Card interactive={false} className="space-y-4 !p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-text-primary">{t('status.platformTitle')}</h2>
            {status.since && <p className="mt-1 text-xs text-text-secondary">{t('status.since', { when: formatDate(status.since) })}</p>}
          </div>
          <Button variant="secondary" size="xs" onClick={onRefresh} loading={refreshing} loadingLabel={t('page.refresh')}>
            <RefreshCw size={14} aria-hidden="true" /> {t('page.refresh')}
          </Button>
        </div>
        {/* Announces level changes to assistive tech without moving focus. */}
        <div role="status" aria-live="polite" aria-atomic="true">
          <LevelBadge t={t} level={level} />
          <p className="mt-2 text-sm text-text-secondary">{t(`status.levels.${level}.desc`)}</p>
        </div>
        {pinned && status.org?.forced_until && (
          <p className="rounded-xl border border-warning-500/30 bg-warning-500/10 px-3 py-2 text-sm text-text-primary">
            {t('status.forcedNote', { level, until: formatDate(status.org.forced_until) })}
          </p>
        )}
      </Card>

      <Card interactive={false} className="!p-6">
        <h2 className="text-base font-semibold text-text-primary">{t('status.ladderTitle')}</h2>
        <ol className="mt-3 space-y-2">
          {LEVELS.map((l) => {
            const current = l === level;
            return (
              <li key={l} aria-current={current ? 'step' : undefined}
                className={`flex gap-3 rounded-xl border px-3 py-2.5 ${current ? 'border-accent bg-accent/10' : 'border-border'}`}>
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border text-xs font-semibold text-text-primary">{l}</span>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-primary">
                    {t(`status.levels.${l}.name`)}
                    {current && <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-white">{t('status.current')}</span>}
                  </span>
                  <span className="block text-sm text-text-secondary">{t(`status.levels.${l}.desc`)}</span>
                </span>
              </li>
            );
          })}
        </ol>
      </Card>

      <Card interactive={false} className="!p-6">
        <h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
          <PhoneForwarded size={18} aria-hidden="true" className="text-accent" /> {t('status.recentTitle')}
        </h2>
        {calls.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-border px-4 py-6 text-center">
            <p className="text-sm font-medium text-text-primary">{t('status.recentEmpty.title')}</p>
            <p className="mt-1 text-sm text-text-secondary">{t('status.recentEmpty.description')}</p>
          </div>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-start text-sm">
              <caption className="sr-only">{t('status.recentTitle')}</caption>
              <thead>
                <tr className="border-b border-border text-xs text-text-secondary">
                  <th scope="col" className="py-2 pe-3 text-start font-medium">{t('status.columns.when')}</th>
                  <th scope="col" className="py-2 pe-3 text-start font-medium">{t('status.columns.level')}</th>
                  <th scope="col" className="py-2 text-start font-medium">{t('status.columns.outcome')}</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c) => (
                  <tr key={c.call_sid} className="border-b border-border/60 last:border-0">
                    <td className="py-2 pe-3 text-text-primary">{formatDate(c.created_at)}</td>
                    <td className="py-2 pe-3 text-text-primary">{c.level}</td>
                    <td className="py-2 text-text-primary">
                      {t(OUTCOME_KEY[c.outcome])}
                      {c.is_emergency && <span className="ms-2 rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-xs font-semibold text-danger">{t('status.emergency')}</span>}
                    </td>
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
