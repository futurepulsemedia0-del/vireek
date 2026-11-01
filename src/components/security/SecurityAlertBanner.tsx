import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useSecurityT } from '@/i18n/securityNamespace';
import { acknowledgeSecurityEvents, fetchBannerKinds } from '@/lib/activityApi';
import type { ActivityKind } from '@/lib/activityFeed';

/** Shown while a password / email / two-step / API-key change is unacknowledged. "This was me" dismisses it for good. */
export function SecurityAlertBanner() {
  const { user } = useAuth();
  const { toast } = useToast();
  const { t } = useSecurityT();
  const [kinds, setKinds] = useState<ActivityKind[]>([]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    fetchBannerKinds(user.id)
      .then((k) => {
        if (!cancelled) setKinds(k);
      })
      .catch(() => undefined); // a banner must never break the page
    return () => {
      cancelled = true;
    };
  }, [user]);

  const dismiss = useCallback(async () => {
    try {
      await acknowledgeSecurityEvents();
      setKinds([]);
    } catch {
      toast(t('banner.dismissFailed'), 'error');
    }
  }, [toast, t]);

  if (kinds.length === 0) return null;
  const events = kinds.map((k) => t(`activity.events.${k}`)).join(', ');
  return (
    <div role="alert" className="mb-4 flex flex-col gap-3 rounded-2xl border border-danger/30 bg-danger/10 p-4 sm:flex-row sm:items-center">
      <ShieldAlert size={20} className="shrink-0 text-danger" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-text-primary">{t('banner.title')}</p>
        <p className="text-sm text-text-secondary">{t('banner.body', { events })}</p>
      </div>
      <div className="flex gap-2">
        <Link to="/dashboard/settings/security" className="focus-ring inline-flex min-h-[40px] items-center rounded-xl border border-border bg-bg-secondary px-4 text-sm font-semibold text-text-primary hover:bg-bg-tertiary">
          {t('banner.secure')}
        </Link>
        <Button size="sm" variant="secondary" onClick={() => void dismiss()}>{t('banner.dismiss')}</Button>
      </div>
    </div>
  );
}
