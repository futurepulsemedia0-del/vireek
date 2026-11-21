import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BadgeCheck, Building2, Check, Copy } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { formatDate, initialsFor, timeAgo } from '@/lib/accountHelpers';
import { StatusPill } from '@/components/account/ui';

export function AccountHero() {
  const { t, i18n } = useTranslation('dashboard');
  const { user, profile, isOwner } = useAuth();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const role = profile?.role ?? (isOwner ? 'owner' : 'member');
  const roleLabel =
    role === 'owner'
      ? t('account.hero.owner', { defaultValue: 'Owner' })
      : role === 'admin'
        ? t('account.hero.admin', { defaultValue: 'Admin' })
        : t('account.hero.member', { defaultValue: 'Team member' });
  const plan = profile?.plan ? profile.plan.charAt(0).toUpperCase() + profile.plan.slice(1) : null;
  const displayName = profile?.full_name?.trim() || user?.email || '';
  const verified = Boolean(user?.email_confirmed_at);

  const copyId = async () => {
    if (!user?.id) return;
    try {
      await navigator.clipboard.writeText(user.id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast(t('account.hero.copyFailed', { defaultValue: 'Could not copy to the clipboard.' }), 'error');
    }
  };

  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark sm:p-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{ background: 'radial-gradient(circle at 0% 0%, rgb(var(--accent-primary) / 0.10), transparent 55%)' }}
      />
      <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center">
        <span
          aria-hidden="true"
          className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xl font-semibold text-accent border border-accent/20"
        >
          {initialsFor(profile?.full_name, user?.email)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold tracking-tight text-text-primary">{displayName}</h2>
            <StatusPill tone="accent">{roleLabel}</StatusPill>
            {plan && <StatusPill>{plan}</StatusPill>}
          </div>
          <p dir="ltr" className="mt-0.5 flex items-center gap-1.5 text-sm text-text-secondary sm:justify-start">
            <span className="truncate">{user?.email}</span>
            {verified && (
              <BadgeCheck size={15} className="shrink-0 text-success" aria-label={t('account.hero.verified', { defaultValue: 'Email verified' })} />
            )}
          </p>
          {profile?.company_name && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-text-secondary">
              <Building2 size={13} aria-hidden="true" />
              {profile.company_name}
            </p>
          )}
        </div>
      </div>

      <dl className="relative mt-5 grid gap-3 border-t border-border/70 pt-4 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-text-muted">{t('account.hero.memberSince', { defaultValue: 'Member since' })}</dt>
          <dd className="mt-0.5 font-medium text-text-primary">{user?.created_at ? formatDate(user.created_at, i18n.language) : '—'}</dd>
        </div>
        <div>
          <dt className="text-text-muted">{t('account.hero.lastSignIn', { defaultValue: 'Last sign-in' })}</dt>
          <dd className="mt-0.5 font-medium text-text-primary">{user?.last_sign_in_at ? timeAgo(user.last_sign_in_at, i18n.language) : '—'}</dd>
        </div>
        <div>
          <dt className="text-text-muted">{t('account.hero.accountId', { defaultValue: 'Account ID' })}</dt>
          <dd className="mt-0.5 flex items-center gap-1.5">
            <code className="truncate font-mono text-[11px] text-text-primary">{user?.id ? `${user.id.slice(0, 8)}…` : '—'}</code>
            {user?.id && (
              <button
                type="button"
                onClick={copyId}
                aria-label={t('account.hero.copyId', { defaultValue: 'Copy account ID' })}
                title={t('account.hero.copyId', { defaultValue: 'Copy account ID' })}
                className="focus-ring flex h-6 w-6 items-center justify-center rounded-md text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
              >
                {copied ? <Check size={13} className="text-success" aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
              </button>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}
