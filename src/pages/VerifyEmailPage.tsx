/**
 * Email verification — /verify-email
 *
 * A plain, unprotected route (never wrap it in <ProtectedRoute>: the person
 * has no session until they verify). Reached from signup/login with
 * `?email=` (and optional `?next=`), or by opening the confirmation link in
 * the email, which lands here already signed in.
 *
 * Views: loading → already-verified | enter-email | enter-code.
 * Code entry, paste, shake/success animation and the resend button are the
 * shared <OtpEntry/>; this page supplies the Supabase calls, a cooldown that
 * survives refreshes, and the hourly resend cap (see lib/emailVerification).
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { ArrowLeft, CheckCircle2, Loader2, Mail, MailCheck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Button } from '@/components/ui/Button';
import { OtpEntry } from '@/components/auth/OtpEntry';
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
import { registerTrustedDevice } from '@/lib/deviceTrust';
import { consumePostAuthRedirect } from '@/lib/inviteRedirect';
import {
  OTP_LENGTH,
  RESEND_COOLDOWN_SECONDS,
  browserStorage,
  getInitialResendSeconds,
  isValidEmail,
  normalizeEmail,
  readPendingEmail,
  resendVerificationEmail,
  safeNextPath,
  verifyEmailCode,
  writePendingEmail,
} from '@/lib/emailVerification';

function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

const BackToSignIn = () => (
  <div className="mt-8 w-full border-t border-border pt-6 text-center">
    <Link
      to="/login"
      className="focus-ring inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary transition-colors hover:text-accent"
    >
      <ArrowLeft size={15} />
      Back to sign in
    </Link>
  </div>
);

function PendingStep({
  email,
  viaForm,
  hasSession,
  onSettled,
  onChangeEmail,
}: {
  email: string;
  viaForm: boolean;
  hasSession: boolean;
  onSettled: () => void;
  onChangeEmail: () => void;
}) {
  const { toast } = useToast();
  // OtpEntry reads its first cooldown from the prop at mount, then uses the
  // current prop after every successful resend — so start from what's left of
  // the persisted cooldown and switch to the standard one right after mount.
  const [initialSeconds] = useState(() => getInitialResendSeconds(email, browserStorage('local'), Date.now()));
  const [cooldown, setCooldown] = useState(initialSeconds);
  useEffect(() => {
    setCooldown(RESEND_COOLDOWN_SECONDS);
  }, []);

  const handleVerify = useCallback(
    async (code: string) => {
      const res = await verifyEmailCode(email, code);
      if (res.success) {
        try {
          await registerTrustedDevice();
        } catch {
          /* Non-fatal: worst case this device gets asked for a code next login. */
        }
        toast('Email verified — welcome to Vireek!', 'success');
      }
      return res;
    },
    [email, toast],
  );

  const handleResend = useCallback(() => resendVerificationEmail(email), [email]);

  return (
    <div className="flex flex-col items-center text-center">
      <AuthIconBadge icon={<MailCheck size={22} />} />
      <h1 className="text-2xl font-bold tracking-tight text-text-primary">Verify your email</h1>
      <p className="mx-auto mt-1.5 max-w-[340px] text-sm leading-relaxed text-text-secondary">
        {viaForm ? 'If ' : 'We sent a 6-digit code and a confirmation link to '}
        <span className="break-all font-semibold text-text-primary">{email}</span>
        {viaForm
          ? ' has an unverified account, we’ve sent a 6-digit code and a confirmation link to it.'
          : '. Enter the code below, or open the link on this device and we’ll sign you in automatically.'}
      </p>

      <div className="mt-8 w-full">
        <OtpEntry
          length={OTP_LENGTH}
          onVerify={handleVerify}
          onResend={handleResend}
          resendCooldownSeconds={cooldown}
          externalSuccess={hasSession}
          onSuccessSettled={onSettled}
        />
      </div>

      <p className="mt-6 max-w-[320px] text-xs leading-relaxed text-text-secondary/70">
        Can’t find it? Check your spam or promotions folder. The code and the link both work — use whichever is easier.
      </p>

      <div className="mt-6">
        <AuthBackLink onClick={onChangeEmail} label="Wrong email? Use a different one" />
      </div>
      <BackToSignIn />
    </div>
  );
}

export function VerifyEmailPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { session, loading } = useAuth();
  const online = useOnline();

  const next = useMemo(() => safeNextPath(params.get('next')), [params]);
  const goNext = useCallback(() => navigate(next ?? consumePostAuthRedirect(), { replace: true }), [navigate, next]);

  const [email, setEmail] = useState(() => {
    const fromUrl = normalizeEmail(params.get('email') ?? '');
    return isValidEmail(fromUrl) ? fromUrl : readPendingEmail();
  });
  const [viaForm, setViaForm] = useState(false);
  const [startedVerified, setStartedVerified] = useState<boolean | null>(null);

  const [formEmail, setFormEmail] = useState('');
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const hasEmail = isValidEmail(email);
  const emailError = !formEmail.trim() ? 'Email is required' : isValidEmail(formEmail) ? '' : 'Please enter a valid email address';

  // Keep the address across refreshes (session-scoped; cleared on "wrong email").
  useEffect(() => {
    writePendingEmail(email);
  }, [email]);

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);

  // Remember whether they arrived already signed in (opened the email link here).
  useEffect(() => {
    if (!loading && startedVerified === null) setStartedVerified(!!session);
  }, [loading, session, startedVerified]);

  useEffect(() => {
    if (startedVerified !== true) return;
    const t = setTimeout(goNext, 1500);
    return () => clearTimeout(t);
  }, [startedVerified, goNext]);

  // Link opened in another tab while this one is on the "enter email" view.
  useEffect(() => {
    if (session && startedVerified === false && !hasEmail) goNext();
  }, [session, startedVerified, hasEmail, goNext]);

  const handleSendCode = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    setError('');
    if (emailError) return;
    if (!online) {
      setError('You’re offline. Reconnect, then try again.');
      return;
    }
    if (sending) return;

    setSending(true);
    const res = await resendVerificationEmail(formEmail);
    setSending(false);

    // `waitSeconds` means we (or the server) sent one moments ago — still go to code entry.
    if (!res.success && res.waitSeconds === undefined) {
      setError(res.error ?? 'We couldn’t send a code. Please try again shortly.');
      return;
    }
    setEmail(normalizeEmail(formEmail));
    setViaForm(true);
  };

  const changeEmail = () => {
    setEmail('');
    setViaForm(false);
    setFormEmail('');
    setTouched(false);
    setError('');
  };

  const view = loading || startedVerified === null ? 'loading' : startedVerified ? 'verified' : hasEmail ? 'code' : 'email';

  return (
    <AuthShell side={<AuthSidePanel />}>
      <div className="absolute right-6 top-5 sm:right-8">
        <ThemeToggle />
      </div>

      {!online && view !== 'loading' && view !== 'verified' && (
        <AuthBanner type="error" message="You’re offline. You can’t verify or resend until you’re back online." />
      )}

      <AuthStepTransition stepKey={view}>
        {view === 'loading' && (
          <div className="flex flex-col items-center py-16 text-center" role="status" aria-live="polite">
            <Loader2 size={24} className="animate-spin text-accent" />
            <p className="mt-3 text-sm text-text-secondary">Checking your session…</p>
          </div>
        )}

        {view === 'verified' && (
          <div className="flex flex-col items-center text-center" role="status" aria-live="polite">
            <AuthIconBadge icon={<CheckCircle2 size={22} />} />
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">Your email is verified</h1>
            <p className="mx-auto mt-1.5 max-w-[320px] text-sm leading-relaxed text-text-secondary">
              You’re all set. Taking you to your account…
            </p>
            <Button type="button" onClick={goNext} className="mt-6">
              Continue
            </Button>
          </div>
        )}

        {view === 'code' && (
          <PendingStep
            key={email}
            email={email}
            viaForm={viaForm}
            hasSession={!!session}
            onSettled={goNext}
            onChangeEmail={changeEmail}
          />
        )}

        {view === 'email' && (
          <>
            <div className="mb-8 flex flex-col items-start text-left">
              <AuthIconBadge icon={<Mail size={22} />} />
              <h1 className="text-2xl font-bold tracking-tight text-text-primary">Verify your email</h1>
              <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">
                Enter the email address you signed up with and we’ll send you a 6-digit code and a confirmation link.
              </p>
            </div>

            <AnimatePresence>
              {error && <AuthBanner type="error" message={error} onDismiss={() => setError('')} />}
            </AnimatePresence>

            <form onSubmit={handleSendCode} noValidate className="space-y-4">
              <AuthInput
                id="email"
                type="email"
                label="Email address"
                icon={<Mail size={18} />}
                autoComplete="email"
                autoFocus
                value={formEmail}
                onChange={(e) => setFormEmail(e.target.value)}
                onBlur={() => setTouched(true)}
                placeholder="you@company.com"
                error={emailError}
                touched={touched}
                isValid={!emailError}
              />
              <AuthSubmitButton
                loading={sending}
                disabled={sending || !online}
                label="Send verification code"
                loadingLabel="Sending…"
              />
            </form>
            <BackToSignIn />
          </>
        )}
      </AuthStepTransition>
    </AuthShell>
  );
}
