import { FormEvent, useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/Button';
import { reauthGate } from '@/lib/session/reauthGate';
import { useFocusTrap } from '@/lib/a11y/focusTrap';
import { announce } from '@/lib/a11y/announcer';

type Step = 'password' | 'mfa';

const field =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary placeholder:text-text-secondary';

/**
 * Non-destructive re-auth. Rendered in a portal ABOVE the untouched page, so route,
 * form state and unsaved work survive. Resolving `true` replays whatever request failed.
 */
export function ReauthModal() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const gate = useSyncExternalStore(reauthGate.subscribe, reauthGate.getState, reauthGate.getState);
  const containerRef = useFocusTrap(gate.open);
  const [step, setStep] = useState<Step>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [factorId, setFactorId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!gate.open) {
      setStep('password');
      setPassword('');
      setCode('');
      setError(null);
      return;
    }
    setEmail((prev) => prev || gate.email || '');
    announce(t('navflow.reauth.announce', { defaultValue: 'Your session expired. Sign in again to continue.' }), 'assertive');
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    return () => root?.removeAttribute('inert');
  }, [gate.open, gate.email, t]);

  if (!gate.open) return null;

  const title =
    gate.reason === 'revoked'
      ? t('navflow.reauth.titleRevoked', { defaultValue: 'You were signed out' })
      : t('navflow.reauth.titleExpired', { defaultValue: 'Your session expired' });

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { data: signedIn, error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (signInError) throw signInError;
      const expected = reauthGate.expectedUserId();
      if (expected && signedIn.user && signedIn.user.id !== expected) {
        // Different account: never keep the previous user's page/data on screen. Reload clean.
        reauthGate.resolve(false);
        window.location.assign('/dashboard');
        return;
      }
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
        const { data: factors, error: fErr } = await supabase.auth.mfa.listFactors();
        const totp = factors?.totp?.[0];
        if (fErr || !totp) throw fErr ?? new Error('no-factor');
        setFactorId(totp.id);
        setStep('mfa');
        return;
      }
      reauthGate.resolve(true);
    } catch {
      setError(t('navflow.reauth.badCredentials', { defaultValue: 'That email or password is not correct.' }));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    setBusy(true);
    setError(null);
    try {
      const { error: vErr } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
      if (vErr) throw vErr;
      reauthGate.resolve(true);
    } catch {
      setError(t('navflow.reauth.badCode', { defaultValue: 'That code is not correct. Try the newest code.' }));
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    reauthGate.resolve(false);
    await supabase.auth.signOut({ scope: 'local' });
    navigate('/login?reason=session_expired', { replace: true });
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[400] flex items-end justify-center bg-text-primary/40 p-4 sm:items-center"
      style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reauth-title"
        aria-describedby="reauth-desc"
        className="w-full max-w-md rounded-2xl border border-border bg-bg-primary p-6 shadow-card-hover"
      >
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Lock className="h-5 w-5" aria-hidden="true" />
          </span>
          <h2 id="reauth-title" className="text-lg font-bold text-text-primary">
            {title}
          </h2>
        </div>
        <p id="reauth-desc" className="mt-3 text-sm leading-6 text-text-secondary">
          {t('navflow.reauth.body', {
            defaultValue: 'Sign in again to keep going. Your page and anything you have not saved stay exactly as they are.',
          })}
        </p>

        {step === 'password' ? (
          <form onSubmit={submitPassword} className="mt-5 space-y-3">
            <label className="block text-sm font-medium text-text-primary">
              {t('navflow.reauth.email', { defaultValue: 'Email' })}
              <input className={`${field} mt-1`} type="email" autoComplete="username" required readOnly={Boolean(gate.email)} value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="block text-sm font-medium text-text-primary">
              {t('navflow.reauth.password', { defaultValue: 'Password' })}
              <input className={`${field} mt-1`} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            <Button type="submit" size="sm" disabled={busy} className="w-full">
              {busy ? t('navflow.reauth.signingIn', { defaultValue: 'Signing in…' }) : t('navflow.reauth.signIn', { defaultValue: 'Sign in and continue' })}
            </Button>
          </form>
        ) : (
          <form onSubmit={submitCode} className="mt-5 space-y-3">
            <label className="block text-sm font-medium text-text-primary">
              {t('navflow.reauth.code', { defaultValue: 'Authenticator code' })}
              <input className={`${field} mt-1`} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value)} />
            </label>
            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            <Button type="submit" size="sm" disabled={busy} className="w-full">
              {t('navflow.reauth.verify', { defaultValue: 'Verify and continue' })}
            </Button>
          </form>
        )}

        <div className="mt-4 flex flex-col gap-2 text-sm sm:flex-row sm:justify-between">
          <button type="button" onClick={() => window.open('/login?reason=session_expired', '_blank', 'noopener')} className="focus-ring rounded-lg px-2 py-1 text-left font-medium text-accent">
            {t('navflow.reauth.otherTab', { defaultValue: 'Use another sign-in method (new tab)' })}
          </button>
          <button type="button" onClick={() => void leave()} className="focus-ring rounded-lg px-2 py-1 text-left text-text-secondary hover:text-text-primary">
            {t('navflow.reauth.leave', { defaultValue: 'Leave without signing in' })}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
