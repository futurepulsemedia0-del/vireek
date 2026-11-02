import { FormEvent, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/Button';
import { findMyPendingRequest, MAX_ACCESS_MESSAGE, requestAccess } from '@/lib/accessRequests';

export type AccessArea = 'technician' | 'staff' | 'page';

type Phase = 'idle' | 'sending' | 'sent' | 'duplicate' | 'error';

const AREA_LABEL: Record<AccessArea, { key: string; fallback: string }> = {
  technician: { key: 'navflow.denied.areaTech', fallback: 'the technician app' },
  staff: { key: 'navflow.denied.areaStaff', fallback: 'the internal staff tools' },
  page: { key: 'navflow.denied.areaPage', fallback: 'this page' },
};

/**
 * Rendered IN PLACE of a guarded page (the URL stays shareable, no silent redirect).
 * Role-aware: owners/admins get a "your role should have access" note, team members
 * can request access from their account owner, platform areas explain who to contact.
 */
export function AccessDenied({ area = 'page' }: { area?: AccessArea }) {
  const { t } = useTranslation();
  const { pathname, search } = useLocation();
  const { profile, isOwner, teamMember } = useAuth();
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  const [alreadyPending, setAlreadyPending] = useState(false);

  const fullPath = `${pathname}${search}`;
  const isAdminRole = profile?.role === 'admin';
  const canRequest = area !== 'staff' && !isOwner && !isAdminRole && Boolean(teamMember);
  const label = t(AREA_LABEL[area].key, { defaultValue: AREA_LABEL[area].fallback });

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${t('navflow.denied.title', { defaultValue: 'Access denied' })} | Vireek`;
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex, nofollow';
    const status = document.createElement('meta');
    status.name = 'prerender-status-code';
    status.content = '403';
    document.head.append(robots, status);
    return () => {
      document.title = previousTitle;
      robots.remove();
      status.remove();
    };
  }, [t]);

  useEffect(() => {
    if (!canRequest) return;
    let cancelled = false;
    void findMyPendingRequest(fullPath).then((r) => {
      if (!cancelled && r) setAlreadyPending(true);
    });
    return () => {
      cancelled = true;
    };
  }, [canRequest, fullPath]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPhase('sending');
    const res = await requestAccess({ path: fullPath, area, message, name: profile?.full_name ?? null });
    setPhase(res.ok ? 'sent' : res.reason === 'duplicate' ? 'duplicate' : 'error');
  }

  const body = isOwner || isAdminRole
    ? t('navflow.denied.bodyOwner', {
        defaultValue: 'Your role normally has access to {{area}}. If your permissions just changed, sign out and back in. If it keeps happening, contact support.',
        area: label,
      })
    : area === 'staff'
      ? t('navflow.denied.bodyStaff', { defaultValue: '{{area}} are only for Vireek staff. If you think you should have access, contact support.', area: label })
      : t('navflow.denied.bodyMember', {
          defaultValue: 'Your account does not have permission to open {{area}}. You can ask the account owner to grant access.',
          area: label,
        });

  const pending = alreadyPending || phase === 'sent' || phase === 'duplicate';

  return (
    <main id="main-content" className="flex min-h-screen flex-col items-center justify-center bg-bg-primary px-6 py-16">
      <div className="w-full max-w-lg rounded-2xl border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <ShieldAlert size={26} aria-hidden="true" />
        </span>
        <p className="mt-5 text-sm font-semibold uppercase tracking-[0.2em] text-accent">403</p>
        <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-text-primary sm:text-3xl">
          {t('navflow.denied.title', { defaultValue: 'Access denied' })}
        </h1>
        <p className="mt-3 text-sm leading-6 text-text-secondary">{body}</p>

        {canRequest && !pending && (
          <form onSubmit={submit} className="mt-6 space-y-3 text-start">
            <label className="block text-sm font-medium text-text-primary">
              {t('navflow.denied.messageLabel', { defaultValue: 'Add a note (optional)' })}
              <textarea
                value={message}
                maxLength={MAX_ACCESS_MESSAGE}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                className="focus-ring mt-1 w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary"
              />
            </label>
            <Button type="submit" className="w-full" disabled={phase === 'sending'}>
              {phase === 'sending'
                ? t('navflow.denied.sending', { defaultValue: 'Sending…' })
                : t('navflow.denied.request', { defaultValue: 'Request access' })}
            </Button>
          </form>
        )}

        <div aria-live="polite" className="mt-4 text-sm">
          {pending && (
            <p className="text-text-secondary">
              {t('navflow.denied.pending', { defaultValue: 'Request sent. The account owner will see it in Team settings.' })}
            </p>
          )}
          {phase === 'error' && (
            <p role="alert" className="text-danger">
              {t('navflow.denied.error', { defaultValue: 'We could not send the request. Please try again.' })}
            </p>
          )}
        </div>

        <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link to="/dashboard" className="focus-ring rounded-xl px-4 py-2 text-sm font-semibold text-accent hover:underline">
            {t('navflow.denied.backDashboard', { defaultValue: 'Back to dashboard' })}
          </Link>
          <Link to="/contact" className="focus-ring rounded-xl px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary">
            {t('navflow.denied.contact', { defaultValue: 'Contact support' })}
          </Link>
        </div>
      </div>
    </main>
  );
}
