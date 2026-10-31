import { useTranslation } from 'react-i18next';
import { useFormat } from '@/hooks/useFormat';
import { useRegional } from '@/contexts/RegionalContext';
import { isolateLtr } from '@/lib/bidi';
import { browserTimeZone, zonedDisplay } from '@/lib/timezone';

interface ZonedTimeProps {
  value: Date | string | number;
  className?: string;
}

/**
 * Schedule/appointment time with zone clarity:
 *   same zone      → "9:00 AM CT"
 *   different zone → "9:00 AM CT (your time 10:00 AM ET)"
 * Business zone = Settings → Regional operations → Time zone (falls back to the viewer's zone).
 */
export function ZonedTime({ value, className }: ZonedTimeProps) {
  const { t } = useTranslation('dashboard');
  const f = useFormat();
  const { regional } = useRegional();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return <span className={className}>—</span>;
  const z = zonedDisplay(d, {
    businessZone: regional.timeZone,
    viewerZone: browserTimeZone(),
    locale: f.locale,
    hourCycle: regional.hourCycle === '12h' ? 'h12' : regional.hourCycle === '24h' ? 'h23' : undefined,
  });
  const text = z.viewerText
    ? t('format.zonedPair', { business: isolateLtr(z.businessText), viewer: isolateLtr(z.viewerText) })
    : isolateLtr(z.businessText);
  return (
    <time dateTime={d.toISOString()} className={className}>
      {text}
    </time>
  );
}
