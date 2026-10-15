import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { CheckCircle2, KeyRound, LifeBuoy, ShieldCheck, Smartphone } from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';
import {
  AuthShell,
  AuthSidePanel,
  AuthInput,
  AuthBanner,
  AuthSubmitButton,
  AuthIconBadge,
  AuthBackLink,
  AuthStepTransition,
} from '@/components/auth/AuthParts';
import { consumePostAuthRedirect } from '@/lib/inviteRedirect';
import {
  LOCKOUT_SECONDS,
  MAX_LOCAL_FAILURES,
  SECURITY_SETTINGS_PATH,
  formatRecoveryInput,
  getMfaGate,
  isRecoveryComplete,
  isTotpComplete,
  redeemRecoveryCode,
  safeNextPath,
  sanitizeTotp,
  signOutToLogin,
  toMfaError,
  verifyTotp,
} from '@/lib/mfaChallenge';

type Phase = 'checking' | 'load-error' | 'ready' | 'success';
type Mode = 'totp' | 'recovery';

const SUCCESS_DELAY_MS = 700;
const RECOVERED_DELAY_MS = 1800;

/**
 * Standalone second-factor challenge. Reached when a signed-in session is still
 * at AAL1 but the account has a verified authenticator (ProtectedRoute sends
 * people here). Two ways through: the 6-digit authenticator code (Supabase
 * native MFA) or a one-time recovery code (mfa-recovery edge function).
 *
 * Plain, unprotected route on purpose — it must render for a session that has
 * NOT finished MFA yet.
 */
export function MfaChallengePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: unknown } | null)?.from;

  const [phase, setPhase] = useState<Phase>('checking');
  const [factorId, setFactorId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('totp');
  const [totp, setTotp] = useState('');
  const [recovery, setRecovery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [failures, setFailures] = useState(0);
  const [lockLeft, setLockLeft] = useState(0);
  const [recovered, setRecovered] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // A pending invite (set before sign-in) wins; otherwise the page the person was heading to.
  // consumePostAuthRedirect() is read once and only when we actually navigate.
  const destination = useCallback(() => {
    const invite = consumePostAuthRedirect();
    return invite !== '/dashboard' ? invite : safeNextPath(from);
  }, [from]);

  const later = (fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  };
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  // ---------- decide what this session needs ----------
  const check = useCallback(async () => {
    setPhase('checking');
    setError('');
    try {
      const gate = await getMfaGate();
      if (gate.kind === 'no-session') {
        navigate('/login', { replace: true });
      } else if (gate.kind === 'ok') {
        navigate(destination(), { replace: true });
      } else {
        setFactorId(gate.factorId);
        setPhase('ready');
      }
    } catch {
      setPhase('load-error');
    }
  }, [navigate, destination]);

  useEffect(() => {
    check();
  }, [check]);

  // ---------- lockout countdown ----------
  useEffect(() => {
    if (lockLeft <= 0) return;
    const t = setTimeout(() => setLockLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [lockLeft]);

  const locked = lockLeft > 0;

  useEffect(() => {
    if (phase === 'ready' && !locked) inputRef.current?.focus();
  }, [phase, mode, locked]);

  const registerFailure = (message: string) => {
    setError(message);
    const next = failures + 1;
    setFailures(next);
    if (next >= MAX_LOCAL_FAILURES) {
      setLockLeft(LOCKOUT_SECONDS);
      setFailures(0);
    }
  };

  // ---------- submit ----------
  const submit = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      if (submittingRef.current || locked || phase !== 'ready') return;
      setError('');

      if (mode === 'totp') {
        if (!factorId || !isTotpComplete(totp)) {
          setError('Enter the 6-digit code from your authenticator app.');
          return;
        }
      } else if (!isRecoveryComplete(recovery)) {
        setError('Enter your 10-character recovery code (for example ABCDE-FGHJK).');
        return;
      }

      submittingRef.current = true;
      setSubmitting(true);
      try {
        if (mode === 'totp') {
          await verifyTotp(factorId as string, totp);
          setPhase('success');
          later(() => navigate(destination(), { replace: true }), SUCCESS_DELAY_MS);
        } else {
          await redeemRecoveryCode(recovery);
          setRecovered(true);
          setPhase('success');
          later(() => navigate(SECURITY_SETTINGS_PATH, { replace: true }), RECOVERED_DELAY_MS);
        }
      } catch (err) {
        const friendly = toMfaError(err, mode);
        if (friendly.kind === 'invalid-code') registerFailure(friendly.message);
        else setError(friendly.message);
        if (friendly.kind === 'rate-limited') setLockLeft(LOCKOUT_SECONDS);
        if (mode === 'totp') setTotp('');
        else setRecovery('');
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, factorId, totp, recovery, locked, phase, navigate, destination, failures],
  );

  // Auto-submit the moment the sixth digit lands (the button stays for keyboard / assistive tech).
  useEffect(() => {
    if (mode === 'totp' && phase === 'ready' && isTotpComplete(totp) && !submittingRef.current && !locked) {
      submit();
    }
  }, [totp, mode, phase, locked, submit]);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError('');
    setTotp('');
    setRecovery('');
  };

  const leave = async () => {
    await signOutToLogin();
    navigate('/login', { replace: true });
  };

  // ---------- views ----------
  const body = (() => {
    if (phase === 'checking') {
      return (
        <div className="flex flex-col items-center py-16 text-center" role="status" aria-live="polite">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent" />
          <p className="mt-4 text-sm text-text-secondary">Checking your security settings…</p>
        </div>
      );
    }

    if (phase === 'load-error') {
      return (
        <div className="flex flex-col items-center text-center">
          <AuthIconBadge icon={<ShieldCheck size={22} />} />
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Couldn't verify your session</h1>
          <p className="mx-auto mt-1.5 max-w-[320px] text-sm leading-relaxed text-text-secondary">
            We couldn't load your two-factor settings. Check your connection and try again.
          </p>
          <button
            type="button"
            onClick={check}
            className="focus-ring mt-6 h-12 w-full rounded-xl bg-accent text-sm font-semibold text-white transition-all hover:brightness-110"
          >
            Try again
          </button>
          <div className="mt-6">
            <AuthBackLink onClick={leave} label="Sign out" />
          </div>
        </div>
      );
    }

    if (phase === 'success') {
      return (
        <div className="flex flex-col items-center text-center" role="status" aria-live="polite">
          <AuthIconBadge icon={<CheckCircle2 size={22} />} />
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">{recovered ? 'Recovery code accepted' : "You're verified"}</h1>
          <p className="mx-auto mt-1.5 max-w-[320px] text-sm leading-relaxed text-text-secondary">
            {recovered
              ? 'Two-factor authentication has been turned off for your account. Taking you to Security settings so you can set it up again.'
              : 'Taking you to your dashboard…'}
          </p>
        </div>
      );
    }

    const isTotp = mode === 'totp';
    return (
      <AuthStepTransition stepKey={mode}>
        <div>
          <div className="flex flex-col items-center text-center">
            <AuthIconBadge icon={isTotp ? <Smartphone size={22} /> : <LifeBuoy size={22} />} />
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">
              {isTotp ? 'Two-factor authentication' : 'Use a recovery code'}
            </h1>
            <p className="mx-auto mt-1.5 max-w-[340px] text-sm leading-relaxed text-text-secondary">
              {isTotp
                ? 'Open your authenticator app and enter the 6-digit code for Vireek.'
                : 'Enter one of the recovery codes you saved when you turned on 2FA. Each code works once, and using one turns 2FA off so you can set it up again.'}
            </p>
          </div>

          <form onSubmit={submit} className="mt-8" noValidate>
            <AnimatePresence>
              {error && <AuthBanner type="error" message={error} onDismiss={() => setError('')} />}
              {locked && (
                <AuthBanner type="error" message={`Too many attempts. You can try again in ${lockLeft}s.`} />
              )}
            </AnimatePresence>

            {isTotp ? (
              <AuthInput
                ref={inputRef}
                id="mfa-totp"
                name="totp"
                label="Authentication code"
                icon={<KeyRound size={18} />}
                value={totp}
                onChange={(e) => setTotp(sanitizeTotp(e.target.value))}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={7}
                placeholder="123456"
                disabled={submitting || locked}
                className="text-center font-mono !text-xl tracking-[0.35em]"
              />
            ) : (
              <AuthInput
                ref={inputRef}
                id="mfa-recovery"
                name="recovery"
                label="Recovery code"
                icon={<LifeBuoy size={18} />}
                value={recovery}
                onChange={(e) => setRecovery(formatRecoveryInput(e.target.value))}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={11}
                placeholder="ABCDE-FGHJK"
                disabled={submitting || locked}
                className="font-mono tracking-widest"
              />
            )}

            <AuthSubmitButton
              loading={submitting}
              disabled={locked || (isTotp ? !isTotpComplete(totp) : !isRecoveryComplete(recovery))}
              label={isTotp ? 'Verify' : 'Use recovery code'}
              loadingLabel="Verifying…"
            />
          </form>

          <div className="mt-6 flex flex-col items-center gap-3 text-sm">
            <button
              type="button"
              onClick={() => switchMode(isTotp ? 'recovery' : 'totp')}
              disabled={submitting}
              className="focus-ring rounded font-semibold text-accent hover:underline disabled:opacity-50"
            >
              {isTotp ? "Can't use your authenticator? Use a recovery code" : 'Use your authenticator app instead'}
            </button>
            <button
              type="button"
              onClick={leave}
              disabled={submitting}
              className="focus-ring rounded text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
            >
              Sign in with a different account
            </button>
          </div>
        </div>
      </AuthStepTransition>
    );
  })();

  return (
    <AuthShell side={<AuthSidePanel />}>
      <div className="absolute right-6 top-5 sm:right-8">
        <ThemeToggle />
      </div>
      {body}
    </AuthShell>
  );
}
