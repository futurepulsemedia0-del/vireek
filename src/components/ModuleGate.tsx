import { ReactNode, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { useEntitlement, refreshEntitlements } from '@/hooks/useEntitlement';
import { useFeatureFlags } from '@/hooks/useFeatureFlag';
import { moduleLabel } from '@/lib/entitlements';

/**
 * Wrap a module's route element. Deny by default:
 *   loading -> skeleton, failed load -> retry, not entitled (or flag off) -> a real "not available" page
 *   rendered IN PLACE (the URL stays shareable, no silent redirect, no flash of the module's UI).
 *
 *   <ProtectedRoute><ModuleGate module="pay" flag="module_pay"><PayPage /></ModuleGate></ProtectedRoute>
 *
 * `flag` is optional: pass the platform feature-flag key to also require the release flag (kill switch / rollout).
 * UI gating is a convenience. Module data must ALSO be protected server-side (has_module() in RLS/RPCs,
 * requireEntitlement() in edge functions).
 */
export function ModuleGate({ module, flag, children }: { module: string; flag?: string; children: ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const ent = useEntitlement(module);
  const flags = useFeatureFlags();

  const flagPending = Boolean(flag) && !flags.ready;
  const flagOff = Boolean(flag) && flags.ready && !flags.isEnabled(flag as string);
  const denied = ent.status === 'ready' && (!ent.allowed || flagOff);

  useEffect(() => {
    if (!denied) return;
    const previousTitle = document.title;
    document.title = `${t('modules.notAvailable.title', { defaultValue: 'Not available' })} | Vireek`;
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex, nofollow';
    document.head.append(robots);
    return () => {
      document.title = previousTitle;
      robots.remove();
    };
  }, [denied, t]);

  if (ent.status === 'loading' || (ent.status === 'ready' && ent.allowed && flagPending)) {
    return (
      <div role="status" aria-busy="true" aria-live="polite" className="flex min-h-[40vh] items-center justify-center p-6">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent" />
        <span className="sr-only">{t('modules.loading', { defaultValue: 'Checking access…' })}</span>
      </div>
    );
  }

  if (ent.status === 'error') {
    return (
      <main className="mx-auto max-w-xl p-6">
        <EmptyState
          variant="load-failed"
          title={t('modules.error.title', { defaultValue: 'We could not check access' })}
          description={t('modules.error.body', { defaultValue: 'Check your connection and try again.' })}
          action={{ label: t('modules.error.retry', { defaultValue: 'Try again' }), onClick: () => { void refreshEntitlements(); } }}
        />
      </main>
    );
  }

  if (denied) {
    const name = moduleLabel(module);
    return (
      <main className="mx-auto max-w-xl p-6" data-testid="module-not-available">
        <EmptyState
          icon={Lock}
          variant="no-permission"
          title={
            ent.expired
              ? t('modules.expired.title', { defaultValue: '{{name}} has expired on your account', name })
              : t('modules.notAvailable.heading', { defaultValue: '{{name}} is not available on your account', name })
          }
          description={t('modules.notAvailable.body', {
            defaultValue: 'This part of Vireek is not turned on for your account. Contact support to add it.',
          })}
          action={{ label: t('modules.notAvailable.support', { defaultValue: 'Contact support' }), onClick: () => navigate('/dashboard/support') }}
          secondaryAction={{ label: t('modules.notAvailable.back', { defaultValue: 'Back to dashboard' }), onClick: () => navigate('/dashboard') }}
        />
      </main>
    );
  }

  return <>{children}</>;
}
