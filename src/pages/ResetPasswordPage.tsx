import { useEffect, useMemo, useRef, useState, FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { Check, Lock, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { supabase } from '@/lib/supabase';
import {
  AuthShell,
  AuthSidePanel,
  AuthInput,
  AuthBanner,
  AuthSubmitButton,
  AuthIconBadge,
} from '@/components/auth/AuthParts';

type Status = 'verifying' | 'ready' | 'submitting' | 'success' | 'invalid';

type Strength = 'weak' | 'medium' | 'strong';

function getPasswordStrength(pw: string): Strength {
  let score = 0;
  if (pw.length >= 8) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (pw.length >= 12) score++;
  if (score <= 1) return 'weak';
  if (score <= 2) return 'medium';
  return 'strong';
}

const STRENGTH_CONFIG: Record<Strength, { label: string; bar: string; text: string }> = {
  weak: { label: 'Weak', bar: 'bg-danger', text: 'text-danger' },
  medium: { label: 'Medium', bar: 'bg-warning-500', text: 'text-warning-500' },
  strong: { label: 'Strong', bar: 'bg-success-500', text: 'text-success-500' },
};

const DEFAULT_INVALID_MESSAGE =
  'This reset link is invalid, expired, or has already been used.';

/**
 * Public, standalone password-reset page.
 *
 * IMPORTANT — this page must never redirect to /login or /dashboard just
 * because there is no *regular* session. A person can land here with zero
 * prior session on this browser/device (that's the whole point of a
 * password reset), so all of the gating below is driven entirely by
 * whether the recovery token in the URL was successfully verified — never
 * by useAuth()/ProtectedRoute-style session checks.
 *
 * Cross-device fix: Supabase's default PKCE flow ties the emailed
 * "Confirm your mail" link to the *browser that requested the reset*
 * (it needs a locally-stored code verifier to redeem the `?code=`
 * parameter). If the email is opened on a different device, that
 * exchange fails. To make the link work anywhere, the Supabase email
 * template must send `{{ .TokenHash }}` instead, and this page verifies
 * it directly via `verifyOtp({ token_hash, type: 'recovery' })`, which is
 * a plain server-side lookup with no per-browser state. See the
 * accompanying setup notes for the exact template to paste into the
 * Supabase dashboard.
 */
export function ResetPasswordPage() {
  const navigate = useNavigate();

  const [status, setStatus] = useState<Status>('verifying');
  const [invalidMessage, setInvalidMessage] = useState('');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [confirmTouched, setConfirmTouched] = useState(false);
  const [formError, setFormError] = useState('');

  const submittingRef = useRef(false);
  // Guards against React 18 StrictMode's dev-only double-invocation of
  // effects, which would otherwise call verifyOtp twice for the same
  // (single-use) token and spuriously flip the page to "invalid" when the
  // second call finds the token already consumed by the first.
  const verifyAttemptedRef = useRef(false);

  const strength = useMemo(() => getPasswordStrength(password), [password]);
  const hasMinLength = password.length >= 8;
  const hasNumber = /[0-9]/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);
  const passwordMeetsPolicy = hasMinLength && hasNumber && hasSymbol;
  const passwordsMatch = confirmPassword === password && password.length > 0;

  // Step 1: consume the recovery token from the URL, if present.
  useEffect(() => {
    let cancelled = false;

    const params = new URLSearchParams(window.location.search);
    const tokenHash = params.get('token_hash');
    const type = params.get('type');
    const linkError = params.get('error_description') || params.get('error');

    // Supabase appends these directly to the redirect URL when the link is
    // already dead server-side (expired / already used / malformed).
    if (linkError) {
      setInvalidMessage(decodeURIComponent(linkError).replace(/\+/g, ' '));
      setStatus('invalid');
      return;
    }

    if (tokenHash && type === 'recovery') {
      if (verifyAttemptedRef.current) return;
      verifyAttemptedRef.current = true;
      supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' }).then(({ error }) => {
        if (cancelled) return;
        // The token is single-use — scrub it from the address bar right
        // away so it can't be replayed from browser history or leaked via
        // a Referer header on this page.
        window.history.replaceState({}, '', '/reset-password');
        if (error) {
          setInvalidMessage(DEFAULT_INVALID_MESSAGE);
          setStatus('invalid');
        } else {
          setStatus('ready');
        }
      });
      return () => {
        cancelled = true;
      };
    }

    // Legacy fallback: an email sent before the token_hash template change
    // below uses an implicit-flow hash fragment (#access_token=...&type=
    // recovery) instead. The Supabase client auto-detects and consumes
    // that on load and fires PASSWORD_RECOVERY (handled in the effect
    // below) — give it a moment before concluding the link is dead.
    const fallbackTimer = setTimeout(() => {
      if (cancelled) return;
      setStatus((current) => (current === 'verifying' ? 'invalid' : current));
      setInvalidMessage((current) => current || DEFAULT_INVALID_MESSAGE);
    }, 2500);

    return () => {
      cancelled = true;
      clearTimeout(fallbackTimer);
    };
  }, []);

  // Step 2: also listen directly for Supabase's recovery event, which
  // covers the legacy hash-fragment link above.
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setStatus('ready');
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError('');
    setPasswordTouched(true);
    setConfirmTouched(true);

    if (!passwordMeetsPolicy) {
      setFormError('Password must be at least 8 characters with a number and a symbol.');
      return;
    }
    if (!passwordsMatch) {
      setFormError('Passwords do not match.');
      return;
    }
    if (submittingRef.current) return; // guard against double submission
    submittingRef.current = true;

    setStatus('submitting');
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;

      // Revoke every active session for this account — including this
      // one — now that the password has changed. `scope: 'global'` signs
      // the account out everywhere, not just this browser, so a leaked
      // old session can't stick around after a reset.
      try {
        await supabase.auth.signOut({ scope: 'global' });
      } catch {
        // Even if the global sign-out call fails (e.g. flaky network),
        // the password itself was already changed successfully — don't
        // block the user on this step, just fall through to redirect.
      }

      setStatus('success');
      // Never auto-login. Send them to a plain sign-in form with their
      // new password.
      setTimeout(() => {
        navigate('/login?reset=success', { replace: true });
      }, 1200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not update your password. Please try again.';
      const lower = msg.toLowerCase();
      if (lower.includes('expired') || lower.includes('session') || lower.includes('jwt') || lower.includes('token')) {
        setInvalidMessage('Your reset session has expired. Please request a new link.');
        setStatus('invalid');
      } else if (lower.includes('different') || lower.includes('same')) {
        setFormError('Your new password must be different from your current password.');
        setStatus('ready');
      } else {
        setFormError(msg);
        setStatus('ready');
      }
    } finally {
      submittingRef.current = false;
    }
  };

  return (
    <AuthShell side={<AuthSidePanel />}>
      <div className="absolute right-6 top-5 sm:right-8">
        <ThemeToggle />
      </div>

      {status === 'verifying' ? (
        <div className="flex flex-col items-center text-center">
          <div className="mb-5 h-10 w-10 animate-spin rounded-full border-2 border-border border-t-accent" />
          <h1 className="text-xl font-bold tracking-tight text-text-primary">Verifying your link…</h1>
          <p className="mx-auto mt-1.5 max-w-[280px] text-sm leading-relaxed text-text-secondary">
            Hang tight while we confirm your password reset link.
          </p>
        </div>
      ) : status === 'invalid' ? (
        <div className="flex flex-col items-center text-center">
          <AuthIconBadge icon={<ShieldAlert size={22} />} />
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Link expired</h1>
          <p className="mx-auto mt-1.5 max-w-[320px] text-sm leading-relaxed text-text-secondary">
            {invalidMessage || DEFAULT_INVALID_MESSAGE}
          </p>
          <Link
            to="/forgot-password"
            className="focus-ring mt-6 flex h-12 w-full items-center justify-center rounded-xl bg-accent text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:brightness-110"
          >
            Request a new link
          </Link>
          <Link
            to="/login"
            className="focus-ring mt-4 text-sm font-medium text-text-secondary transition-colors hover:text-accent"
          >
            Back to sign in
          </Link>
        </div>
      ) : status === 'success' ? (
        <div className="flex flex-col items-center text-center">
          <AuthIconBadge icon={<ShieldCheck size={22} />} />
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Password updated</h1>
          <p className="mx-auto mt-1.5 max-w-[320px] text-sm leading-relaxed text-text-secondary">
            You&rsquo;ve been signed out everywhere for security. Redirecting you to sign in…
          </p>
        </div>
      ) : (
        <div>
          <div className="mb-8 text-left">
            <AuthIconBadge icon={<Lock size={22} />} />
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">Set a new password</h1>
            <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">
              Choose a strong new password for your Vireek account.
            </p>
          </div>

          <AnimatePresence>
            {formError && (
              <AuthBanner type="error" message={formError} onDismiss={() => setFormError('')} />
            )}
          </AnimatePresence>

          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div>
              <AuthInput
                id="newPassword"
                type="password"
                label="New password"
                icon={<Lock size={18} />}
                autoComplete="new-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onBlur={() => setPasswordTouched(true)}
                placeholder="Create a new password"
                showPasswordToggle
                touched={passwordTouched}
                isValid={passwordMeetsPolicy}
                aria-describedby="new-password-requirements"
              />
              {password.length > 0 && (
                <div className="mt-2 flex items-center gap-2">
                  <div className="flex h-1.5 flex-1 gap-1">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className={`h-full flex-1 rounded-full transition-colors ${
                          i <= (strength === 'weak' ? 0 : strength === 'medium' ? 1 : 2)
                            ? STRENGTH_CONFIG[strength].bar
                            : 'bg-border'
                        }`}
                      />
                    ))}
                  </div>
                  <span className={`text-xs font-medium ${STRENGTH_CONFIG[strength].text}`}>
                    {STRENGTH_CONFIG[strength].label}
                  </span>
                </div>
              )}
              <ul id="new-password-requirements" className="mt-2 space-y-1">
                {[
                  { met: hasMinLength, label: 'At least 8 characters' },
                  { met: hasNumber, label: 'At least one number' },
                  { met: hasSymbol, label: 'At least one symbol (e.g. ! @ # $ %)' },
                ].map(({ met, label }) => (
                  <li
                    key={label}
                    className={`flex items-center gap-1.5 text-xs transition-colors ${
                      met ? 'text-success-500' : passwordTouched ? 'text-danger' : 'text-text-secondary/60'
                    }`}
                  >
                    {met ? (
                      <Check size={12} className="shrink-0" />
                    ) : passwordTouched ? (
                      <X size={12} className="shrink-0" />
                    ) : (
                      <span className="ml-[1px] h-1 w-1 shrink-0 rounded-full bg-current" />
                    )}
                    {label}
                  </li>
                ))}
              </ul>
            </div>

            <AuthInput
              id="confirmNewPassword"
              type="password"
              label="Confirm new password"
              icon={<Lock size={18} />}
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              onBlur={() => setConfirmTouched(true)}
              placeholder="Re-enter your new password"
              showPasswordToggle
              error={confirmTouched && !passwordsMatch ? 'Passwords do not match' : ''}
              touched={confirmTouched}
              isValid={passwordsMatch}
            />

            <AuthSubmitButton
              loading={status === 'submitting'}
              disabled={!passwordMeetsPolicy || !passwordsMatch}
              label="Update password"
              loadingLabel="Updating…"
            />
          </form>
        </div>
      )}
    </AuthShell>
  );
}
