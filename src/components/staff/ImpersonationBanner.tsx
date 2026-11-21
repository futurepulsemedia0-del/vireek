import { ShieldAlert } from 'lucide-react';
import { useImpersonation } from '@/hooks/useImpersonation';
import { useImpersonationT } from '@/i18n/impersonationNamespace';
import { formatCountdown, IMPERSONATION_WARN_SECONDS } from '@/lib/impersonation';

/**
 * Always-visible notice while a Vireek Support session is active. Renders nothing for normal sessions.
 * Logical (start/end) spacing only, so it mirrors correctly in RTL languages.
 */
export function ImpersonationBanner() {
  const { active, secondsLeft, ending, end } = useImpersonation();
  const { t } = useImpersonationT();
  if (!active) return null;

  const time = formatCountdown(secondsLeft);
  const urgent = secondsLeft <= IMPERSONATION_WARN_SECONDS;

  return (
    <div
      role={urgent ? 'alert' : 'status'}
      aria-live={urgent ? 'assertive' : 'polite'}
      data-testid="impersonation-banner"
      className={`sticky top-0 z-[60] flex w-full flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 text-sm font-medium print:hidden ${urgent ? 'bg-danger text-on-danger' : 'bg-warning text-on-warning'}`}
    >
      <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <span className="font-semibold">{t('title')}</span>
        <span className="ms-2 opacity-95">{urgent ? t('expiring', { time }) : t('detail', { time })}</span>
      </div>
      <button
        type="button"
        onClick={() => void end()}
        disabled={ending}
        className="ms-auto rounded-md border border-white/70 px-3 py-1 text-xs font-semibold hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-60"
      >
        {ending ? t('ending') : t('end')}
      </button>
    </div>
  );
}
