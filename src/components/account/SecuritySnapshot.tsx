import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Laptop, LogOut, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import { providerLabel } from '@/lib/accountHelpers';
import { StatusPill, secondaryBtn } from '@/components/account/ui';

type MfaState = 'loading' | 'on' | 'off' | 'error';

export function SecuritySnapshot() {
  const { t } = useTranslation('dashboard');
  const { user } = useAuth();
  const { toast } = useToast();
  const [mfa, setMfa] = useState<MfaState>('loading');
  const [confirming, setConfirming] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let alive = true;
    supabase.auth.mfa
      .listFactors()
      .then(({ data, error }) => {
        if (!alive) return;
        if (error || !data) setMfa('error');
        else setMfa(data.totp.some((f) => f.status === 'verified') ? 'on' : 'off');
      })
      .catch(() => {
        if (alive) setMfa('error');
      });
    return () => {
      alive = false;
    };
  }, []);

  const providers = useMemo(() => {
    const list = [...new Set((user?.identities ?? []).map((i) => i.provider))];
    return list.length > 0 ? list : ['email'];
  }, [user]);

  const signOutOthers = async () => {
    setSigningOut(true);
    const { error } = await supabase.auth.signOut({ scope: 'others' });
    setSigningOut(false);
    setConfirming(false);
    if (error) toast(t('account.securityCard.signOutFailed', { defaultValue: 'Could not sign out other sessions: {{message}}', message: error.message }), 'error');
    else toast(t('account.securityCard.signedOutOthers', { defaultValue: 'Every other session has been signed out.' }), 'success');
  };

  const row = 'flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-bg-primary px-4 py-3';
  const manage = 'focus-ring rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10';

  return (
    <div className="space-y-3">
      <div className={row}>
        <div>
          <p className="text-sm font-medium text-text-primary">{t('account.securityCard.mfa', { defaultValue: 'Two-step verification' })}</p>
          <p className="text-xs text-text-secondary">
            {t('account.securityCard.mfaHint', { defaultValue: 'An authenticator-app code on top of your password.' })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {mfa === 'loading' && <StatusPill>{t('account.securityCard.checking', { defaultValue: 'Checking…' })}</StatusPill>}
          {mfa === 'on' && (
            <StatusPill tone="success">
              <ShieldCheck size={12} aria-hidden="true" /> {t('account.securityCard.on', { defaultValue: 'On' })}
            </StatusPill>
          )}
          {mfa === 'off' && <StatusPill tone="warning">{t('account.securityCard.off', { defaultValue: 'Off — recommended' })}</StatusPill>}
          {mfa === 'error' && <StatusPill>{t('account.securityCard.unavailable', { defaultValue: 'Unavailable' })}</StatusPill>}
          <Link to="/dashboard/settings/security" className={manage}>
            {t('account.securityCard.manage', { defaultValue: 'Manage' })}
          </Link>
        </div>
      </div>

      <div className={row}>
        <div>
          <p className="text-sm font-medium text-text-primary">{t('account.securityCard.methods', { defaultValue: 'Sign-in methods' })}</p>
          <p className="text-xs text-text-secondary">{t('account.securityCard.methodsHint', { defaultValue: 'How you can sign in to this account.' })}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {providers.map((p) => (
            <StatusPill key={p}>{providerLabel(p)}</StatusPill>
          ))}
        </div>
      </div>

      <div className={row}>
        <div className="flex items-center gap-3">
          <Laptop size={18} className="text-text-secondary" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium text-text-primary">{t('account.securityCard.sessions', { defaultValue: 'Active sessions' })}</p>
            <p className="text-xs text-text-secondary">{t('account.securityCard.sessionsHint', { defaultValue: 'See where you are signed in and revoke any session.' })}</p>
          </div>
        </div>
        <Link to="/dashboard/settings/sessions" className={manage}>
          {t('account.securityCard.review', { defaultValue: 'Review' })}
        </Link>
      </div>

      <div className="pt-1">
        {confirming ? (
          <div role="alertdialog" aria-label={t('account.securityCard.confirmTitle', { defaultValue: 'Sign out other devices' })} className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning-subtle px-4 py-3">
            <p className="flex-1 text-sm text-text-primary">
              {t('account.securityCard.confirm', { defaultValue: 'Sign out everywhere except this device?' })}
            </p>
            <button type="button" onClick={signOutOthers} disabled={signingOut} className="focus-ring rounded-lg bg-danger px-3 py-1.5 text-xs font-semibold text-on-danger disabled:opacity-60">
              {signingOut ? t('account.securityCard.signingOut', { defaultValue: 'Signing out…' }) : t('account.securityCard.confirmYes', { defaultValue: 'Yes, sign out' })}
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={signingOut} className="focus-ring rounded-lg px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-tertiary">
              {t('account.email.cancel')}
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirming(true)} className={secondaryBtn}>
            <LogOut size={15} aria-hidden="true" />
            {t('account.securityCard.signOutOthers', { defaultValue: 'Sign out of all other devices' })}
          </button>
        )}
      </div>
    </div>
  );
}
