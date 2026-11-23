import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CalendarClock, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { LIFECYCLE_NS } from '@/i18n/lifecycleNamespace';
import {
  daysUntilSunset,
  isSafeAppRoute,
  isSafeHttpsUrl,
  isUrgent,
  localizedCopy,
  selectBannerEntries,
  type DeprecationEntry,
} from '../../supabase/functions/_shared/lifecycle/deprecations';
import { DEPRECATION_REGISTRY } from '../../supabase/functions/_shared/lifecycle/registry';

// ============================================================
// DeprecationBanner
// ============================================================
//
// Dashboard banner (same slot as TrialBanner / UsageLimitBanner) driven ONLY by the lifecycle registry
// (supabase/functions/_shared/lifecycle/registry.ts). Which entries show, where, to whom and from when is decided by
// selectBannerEntries(); policy: docs/product/lifecycle-policy.md. Renders nothing when no entry qualifies.
//
//  - Dismissible per entry on this device only (localStorage). It cannot be dismissed in the last URGENT_DAYS days,
//    and a dismissal never replaces the email / changelog notices the policy requires.
//  - Registry text is English with optional per-language overrides; labels come from the `lifecycle` i18n namespace.
//  - Dates are shown as ISO (YYYY-MM-DD) inside a LTR <time>: unambiguous in every language and safe in RTL layouts.

const DISMISS_STORAGE_PREFIX = 'vireek-deprecation-dismissed-v1';

function readDismissed(userId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(`${DISMISS_STORAGE_PREFIX}:${userId}`);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function persistDismissed(userId: string, ids: Set<string>): void {
  try {
    window.localStorage.setItem(`${DISMISS_STORAGE_PREFIX}:${userId}`, JSON.stringify([...ids]));
  } catch {
    // Non-fatal: the notice just comes back on the next visit.
  }
}

const linkClass =
  'focus-ring inline-flex min-h-[44px] items-center rounded-xl px-3 text-sm font-semibold text-accent transition-colors duration-150 hover:underline';

interface NoticeProps {
  entry: DeprecationEntry;
  nowMs: number;
  onDismiss: (id: string) => void;
}

function Notice({ entry, nowMs, onDismiss }: NoticeProps) {
  const { t, i18n } = useTranslation(LIFECYCLE_NS);
  const copy = localizedCopy(entry, i18n.language);
  const days = daysUntilSunset(entry, nowMs);
  const urgent = isUrgent(entry, nowMs);
  const replacement = entry.replacement;
  const exportRoute = entry.dataExport.holdsCustomerData && isSafeAppRoute(entry.dataExport.exportRoute) ? entry.dataExport.exportRoute : null;

  let timing: string;
  if (days > 0) timing = t('daysLeft', { count: days });
  else if (days === 0) timing = t('dueToday');
  else timing = t('sunsetPassed');

  return (
    <div
      data-testid={`deprecation-${entry.id}`}
      className={`flex flex-col gap-3 rounded-2xl border p-4 shadow-card sm:flex-row sm:items-start sm:justify-between ${
        urgent ? 'border-warning/30 bg-warning-subtle' : 'border-accent/20 bg-accent/10'
      }`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${urgent ? 'bg-warning-subtle text-warning' : 'bg-accent/15 text-accent'}`}>
          <Icon icon={CalendarClock} size="md" />
        </span>
        <div className="min-w-0 text-start">
          <p className="text-sm font-semibold text-text-primary">{t('headline', { title: copy.title })}</p>
          <p className="mt-0.5 text-xs text-text-secondary">{copy.summary}</p>
          <p className="mt-1 text-xs text-text-secondary">
            {t('removalDate')}{' '}
            <time dateTime={entry.sunsetAt} dir="ltr" className="font-semibold text-text-primary">
              {entry.sunsetAt}
            </time>
            {' · '}
            {timing}
            {exportRoute && days > 0 ? ` · ${t('exportHint')}` : ''}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1 self-end sm:self-center">
        {exportRoute && (
          <Link to={exportRoute} className={linkClass}>
            {t('exportData')}
          </Link>
        )}
        {replacement && isSafeAppRoute(replacement.route) && (
          <Link to={replacement.route} className={linkClass}>
            {t('replacement', { label: replacement.label })}
          </Link>
        )}
        {replacement && !isSafeAppRoute(replacement.route) && isSafeHttpsUrl(replacement.url) && (
          <a href={replacement.url} target="_blank" rel="noopener noreferrer" className={linkClass}>
            {t('replacement', { label: replacement.label })}
          </a>
        )}
        {isSafeHttpsUrl(entry.migrationUrl) && (
          <a href={entry.migrationUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>
            {t('migrationGuide')}
          </a>
        )}
        {!urgent && <IconButton label={t('dismiss', { title: copy.title })} icon={X} size="sm" onClick={() => onDismiss(entry.id)} />}
      </div>
    </div>
  );
}

export function DeprecationBanner({ entries = DEPRECATION_REGISTRY }: { entries?: readonly DeprecationEntry[] }) {
  const { user, isOwner, profileLoading } = useAuth();
  const { pathname } = useLocation();
  const { t } = useTranslation(LIFECYCLE_NS);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [hydrated, setHydrated] = useState(false);
  const userId = user?.id ?? null;

  useEffect(() => {
    setDismissed(userId ? readDismissed(userId) : new Set());
    setHydrated(true);
  }, [userId]);

  // Re-evaluated on every navigation so a long-lived tab picks up a day change.
  const nowMs = useMemo(() => Date.now(), [pathname]);
  const visible = useMemo(
    () =>
      selectBannerEntries(entries, { nowMs, pathname, isOwner: Boolean(isOwner) }).filter(
        (e) => isUrgent(e, nowMs) || !dismissed.has(e.id),
      ),
    [entries, nowMs, pathname, isOwner, dismissed],
  );

  const dismiss = useCallback(
    (id: string) => {
      if (!userId) return;
      const next = new Set(dismissed).add(id);
      persistDismissed(userId, next);
      setDismissed(next);
    },
    [userId, dismissed],
  );

  if (!hydrated || profileLoading || !userId || visible.length === 0) return null;

  return (
    <div role="region" aria-label={t('regionLabel')} className="mb-6 flex flex-col gap-3">
      {visible.map((entry) => (
        <Notice key={entry.id} entry={entry} nowMs={nowMs} onDismiss={dismiss} />
      ))}
    </div>
  );
}
