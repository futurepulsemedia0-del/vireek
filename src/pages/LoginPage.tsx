import { useState, FormEvent, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { Mail, Lock, MailCheck, KeyRound, Sparkles } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { ThemeToggle } from '@/components/ThemeToggle';
import { supabase } from '@/lib/supabase';
import {
  AuthShell,
  AuthSidePanel,
  AuthInput,
  AuthBanner,
  AuthDivider,
  GoogleButton,
  AuthSubmitButton,
  AuthLegalLine,
  AuthStepTransition,
  AuthBackLink,
  AuthIconBadge,
} from '@/components/auth/AuthParts';
import { OtpEntry } from '@/components/auth/OtpEntry';
import { checkDeviceTrusted, registerTrustedDevice } from '@/lib/deviceTrust';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Password reset now lives entirely on the dedicated /forgot-password and
// /reset-password pages — see those files for that flow. This page keeps
// only the steps that are genuinely part of signing in: post-signup email
// confirmation, and the new-device OTP step-up below.
type LoginStep = 'signin' | 'confirm-email' | 'device-otp' | 'magic-link-sent';

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { session, loading } = useAuth();
  const { toast } = useToast();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [emailTouched, setEmailTouched] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [authError, setAuthError] = useState('');
  const [showSuccess, setShowSuccess] = useState(false);
  const [passwordResetBanner, setPasswordResetBanner] = useState(false);

  const [step, setStep] = useState<LoginStep>('signin');
  const [pendingEmail, setPendingEmail] = useState('');
  const [deviceChecking, setDeviceChecking] = useState(false);
  const [signInMode, setSignInMode] = useState<'password' | 'magic-link'>('password');
  const [magicLinkSending, setMagicLinkSending] = useState(false);
  // Only auto-redirect on an existing session while on the plain sign-in
  // step (the confirm-email / device-otp steps handle their own
  // navigation once their success animation settles).
  useEffect(() => {
    if (!loading && session && (step === 'signin' || step === 'magic-link-sent')) {
      // Clicking a magic link is itself proof of email possession — the
      // same bar the 6-digit device-otp step exists to clear — so treat
      // this browser as trusted going forward instead of showing an OTP
      // screen the user never asked for.
      registerTrustedDevice().catch(() => {});
      navigate('/dashboard', { replace: true });
    }
  }, [session, loading, step, navigate]);
  // Show a one-time confirmation banner after a successful password reset
  // on /reset-password, then scrub the query param so it doesn't persist
  // across refreshes or get shared if the URL is copied.
  useEffect(() => {
    if (searchParams.get('reset') === 'success') {
      setPasswordResetBanner(true);
      const next = new URLSearchParams(searchParams);
      next.delete('reset');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const validateEmail = useCallback(() => {
    if (!email.trim()) {
      setEmailError('Email is required');
      return false;
    }
    if (!EMAIL_REGEX.test(email.trim())) {
      setEmailError('Please enter a valid email address');
      return false;
    }
    setEmailError('');
    return true;
  }, [email]);

  const isFormValid = EMAIL_REGEX.test(email.trim()) && password.length >= 6;

  const handleEmailBlur = () => {
    setEmailTouched(true);
    validateEmail();
  };

  const handleSignIn = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError('');

    if (!validateEmail()) return;
    if (password.length < 6) {
      setAuthError('Password must be at least 6 characters');
      return;
    }

    setSubmitting(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) throw error;

      // Password checked out. Before handing over a real session, make sure
      // this browser has already completed a full verification before —
      // otherwise step up to an OTP challenge and don't let the password
      // alone be enough on a device we've never seen.
      setDeviceChecking(true);
      const trusted = await checkDeviceTrusted();
      setDeviceChecking(false);

      if (trusted) {
        setShowSuccess(true);
        toast('Welcome back to Vireek!', 'success');
        setTimeout(() => navigate('/dashboard', { replace: true }), 600);
        return;
      }

      // Unrecognized device: drop the session we just got from the password
      // check and require a fresh 6-digit code before granting one back.
      await supabase.auth.signOut();
      setPendingEmail(email.trim());
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: false },
      });
      if (otpError) {
        setAuthError('Could not send a verification code. Please try again.');
        return;
      }
      setStep('device-otp');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sign in failed. Please try again.';
      const lower = msg.toLowerCase();

      if (lower.includes('confirm')) {
        // Account exists but the email hasn't been verified yet — send a
        // fresh code and drop them straight into the same OTP screen used
        // right after signup, instead of a dead-end error.
        setPendingEmail(email.trim());
        setStep('confirm-email');
        try {
          await supabase.auth.resend({ type: 'signup', email: email.trim() });
        } catch {
          /* the OTP screen's own "resend" button covers this if it fails */
        }
        setSubmitting(false);
        return;
      }

      setAuthError(lower.includes('invalid') ? 'Invalid email or password. Please try again.' : msg);
    } finally {
      setSubmitting(false);
    }
  };
        const handleMagicLinkRequest = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError('');
    if (!validateEmail()) return;

    setMagicLinkSending(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          shouldCreateUser: false,
          emailRedirectTo: `${window.location.origin}/dashboard`,
        },
      });
      if (error) throw error;
      setPendingEmail(email.trim());
      setStep('magic-link-sent');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not send a magic link. Please try again.';
      setAuthError(msg.toLowerCase().includes('not found') ? 'No account found with that email.' : msg);
    } finally {
      setMagicLinkSending(false);
    }
  };

  const handleResendMagicLink = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: pendingEmail,
        options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}/dashboard` },
      });
      if (error) return { success: false, error: error.message };
      return { success: true };
    } catch {
      return { success: false, error: "Couldn't resend the link. Try again shortly." };
    }
  }, [pendingEmail]);

  const handleGoogleSignIn = async () => {
    setAuthError('');
    setGoogleLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${window.location.origin}/dashboard` },
      });
      if (error) throw error;
    } catch (err) {
      setGoogleLoading(false);
      const msg = err instanceof Error ? err.message : 'Google sign-in failed.';
      setAuthError(
        msg.toLowerCase().includes('provider') || msg.toLowerCase().includes('not')
          ? 'Google sign-in is not configured. Please use email and password.'
          : msg
      );
    }
  };

  // ---- Confirm-email OTP (post-signup, unconfirmed login attempt) ----
  // Unrelated to password reset — kept exactly as before.

  const handleVerifyConfirmOtp = useCallback(
    async (code: string): Promise<{ success: boolean; error?: string }> => {
      try {
        const { error } = await supabase.auth.verifyOtp({
          email: pendingEmail,
          token: code,
          type: 'email',
        });
        if (error) {
          const msg = error.message.toLowerCase();
          if (msg.includes('expired')) {
            return { success: false, error: 'This code has expired. Send a new one below.' };
          }
          return { success: false, error: "That code isn't right — try again." };
        }
        try {
          await registerTrustedDevice();
        } catch {
          /* Non-fatal: worst case this device gets asked for OTP again next time. */
        }
        toast('Email verified — welcome back!', 'success');
        return { success: true };
      } catch {
        return { success: false, error: 'Something went wrong verifying that code.' };
      }
    },
    [pendingEmail, toast]
  );

  const handleResendConfirmOtp = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    try {
      const { error } = await supabase.auth.resend({ type: 'signup', email: pendingEmail });
      if (error) return { success: false, error: error.message };
      return { success: true };
    } catch {
      return { success: false, error: "Couldn't resend the code. Try again shortly." };
    }
  }, [pendingEmail]);

  // ---- New-device OTP step-up (password already verified, device unknown) ----
  // Unrelated to password reset — kept exactly as before.

  const handleVerifyDeviceOtp = useCallback(
    async (code: string): Promise<{ success: boolean; error?: string }> => {
      try {
        const { error } = await supabase.auth.verifyOtp({
          email: pendingEmail,
          token: code,
          type: 'email',
        });
        if (error) {
          const msg = error.message.toLowerCase();
          if (msg.includes('expired')) {
            return { success: false, error: 'This code has expired. Send a new one below.' };
          }
          return { success: false, error: "That code isn't right — try again." };
        }
        // Only now, after a real second factor succeeded, remember this
        // browser so future logins can skip this step.
        try {
          await registerTrustedDevice();
        } catch {
          /* Non-fatal: worst case this device gets asked for OTP again next time. */
        }
        toast('Device verified — welcome back!', 'success');
        return { success: true };
      } catch {
        return { success: false, error: 'Something went wrong verifying that code.' };
      }
    },
    [pendingEmail, toast]
  );

  const handleResendDeviceOtp = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: pendingEmail,
        options: { shouldCreateUser: false },
      });
      if (error) return { success: false, error: error.message };
      return { success: true };
    } catch {
      return { success: false, error: "Couldn't resend the code. Try again shortly." };
    }
  }, [pendingEmail]);

  const backToSignIn = () => {
    setStep('signin');
    setAuthError('');
    setDeviceChecking(false);
  };

  return (
    <AuthShell side={<AuthSidePanel />}>
      {/* Theme toggle in top-right of form side */}
      <div className="absolute right-6 top-5 sm:right-8">
        <ThemeToggle />
      </div>

      <AuthStepTransition stepKey={step}>
        {step === 'confirm-email' ? (
          <div className="flex flex-col items-center text-center">
            <AuthIconBadge icon={<MailCheck size={22} />} />
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">Verify your email</h1>
            <p className="mx-auto mt-1.5 max-w-[320px] text-sm leading-relaxed text-text-secondary">
              Your account needs one more step. We sent a 6-digit code and a confirmation link to{' '}
              <span className="font-semibold text-text-primary">{pendingEmail}</span>.
            </p>
            <div className="mt-8 w-full">
              <OtpEntry
                length={6}
                onVerify={handleVerifyConfirmOtp}
                onResend={handleResendConfirmOtp}
                externalSuccess={!!session}
                onSuccessSettled={() => navigate('/dashboard', { replace: true })}
              />
            </div>
            <div className="mt-8">
              <AuthBackLink onClick={backToSignIn} label="Back to sign in" />
            </div>
          </div>
        ) : step === 'magic-link-sent' ? (
          <div className="flex flex-col items-center text-center">
            <AuthIconBadge icon={<Sparkles size={22} />} />
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">Check your email</h1>
            <p className="mx-auto mt-1.5 max-w-[320px] text-sm leading-relaxed text-text-secondary">
              We sent a sign-in link to{' '}
              <span className="font-semibold text-text-primary">{pendingEmail}</span>. Open it on
              this device to finish signing in — no password needed.
            </p>
            <button
              type="button"
              onClick={async () => {
                const result = await handleResendMagicLink();
                toast(
                  result.success ? 'Link resent — check your inbox.' : (result.error ?? 'Could not resend.'),
                  result.success ? 'success' : 'error'
                );
              }}
              className="focus-ring mt-6 text-sm font-semibold text-accent hover:underline"
            >
              Resend link
            </button>
            <div className="mt-8">
              <AuthBackLink onClick={backToSignIn} label="Back to sign in" />
            </div>
          </div>
        ) : step === 'device-otp' ? (
          <div className="flex flex-col items-center text-center">
            <AuthIconBadge icon={<KeyRound size={22} />} />
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">New device detected</h1>
            <p className="mx-auto mt-1.5 max-w-[320px] text-sm leading-relaxed text-text-secondary">
              We don&rsquo;t recognize this browser. Enter the 6-digit code we sent to{' '}
              <span className="font-semibold text-text-primary">{pendingEmail}</span> to finish signing in.
            </p>
            <div className="mt-8 w-full">
              <OtpEntry
                length={6}
                onVerify={handleVerifyDeviceOtp}
                onResend={handleResendDeviceOtp}
                onSuccessSettled={() => navigate('/dashboard', { replace: true })}
              />
            </div>
            <div className="mt-8">
              <AuthBackLink onClick={backToSignIn} label="Back to sign in" />
            </div>
          </div>
        ) : (
          <>
            {/* Heading */}
            <div className="mb-8">
              <h1 className="text-2xl font-bold tracking-tight text-text-primary">Welcome back</h1>
              <p className="mt-1.5 text-sm text-text-secondary">
                Sign in to your Vireek account to manage calls, leads, and bookings.
              </p>
            </div>

            {/* Google */}
            <GoogleButton
              onClick={handleGoogleSignIn}
              loading={googleLoading}
              disabled={submitting}
              label="Continue with Google"
            />

            <AuthDivider />

            {/* Banners */}
            <AnimatePresence>
              {passwordResetBanner && (
                <AuthBanner
                  type="success"
                  message="Password updated successfully. Sign in with your new password."
                  onDismiss={() => setPasswordResetBanner(false)}
                />
              )}
              {authError && (
                <AuthBanner type="error" message={authError} onDismiss={() => setAuthError('')} />
              )}
              {showSuccess && (
                <AuthBanner type="success" message="Signed in successfully! Redirecting…" />
              )}
            </AnimatePresence>

            {/* Form */}
            <form onSubmit={signInMode === 'password' ? handleSignIn : handleMagicLinkRequest} noValidate className="space-y-4">
              <AuthInput
                id="email"
                type="email"
                label="Email address"
                icon={<Mail size={18} />}
                autoComplete="email"
                autoFocus
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (emailTouched) validateEmail();
                }}
                onBlur={handleEmailBlur}
                placeholder="you@company.com"
                error={emailError}
                touched={emailTouched}
                isValid={EMAIL_REGEX.test(email.trim())}
              />

              {signInMode === 'password' && (
                <>
                  <AuthInput
                    id="password"
                    type="password"
                    label="Password"
                    icon={<Lock size={18} />}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    showPasswordToggle
                  />

                  {/* Remember + forgot */}
                  <div className="flex items-center justify-between">
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-text-secondary select-none">
                      <input
                        type="checkbox"
                        checked={rememberMe}
                        onChange={(e) => setRememberMe(e.target.checked)}
                        className="h-4 w-4 rounded border-border accent-accent"
                      />
                      Remember me
                    </label>
                    <Link
                      to="/forgot-password"
                      className="focus-ring rounded text-sm font-medium text-accent transition-colors hover:underline"
                    >
                      Forgot password?
                    </Link>
                  </div>
                </>
              )}

              <AuthSubmitButton
                loading={signInMode === 'password' ? submitting : magicLinkSending}
                disabled={
                  googleLoading ||
                  (signInMode === 'password' ? !isFormValid : !EMAIL_REGEX.test(email.trim()))
                }
                label={signInMode === 'password' ? 'Sign In' : 'Send Magic Link'}
                loadingLabel={
                  signInMode === 'password'
                    ? deviceChecking
                      ? 'Checking device…'
                      : 'Signing in…'
                    : 'Sending link…'
                }
              />

              <button
                type="button"
                onClick={() => {
                  setSignInMode((m) => (m === 'password' ? 'magic-link' : 'password'));
                  setAuthError('');
                }}
                className="focus-ring block w-full text-center text-sm font-medium text-text-secondary transition-colors hover:text-accent"
              >
                {signInMode === 'password' ? 'Sign in with a magic link instead' : 'Sign in with a password instead'}
              </button>
            </form>

            {/* Footer */}
            <div className="mt-8 border-t border-border pt-6 text-center">
              <p className="text-sm text-text-secondary">
                Don&rsquo;t have an account?{' '}
                <Link to="/signup" className="font-semibold text-accent transition-colors hover:underline">
                  Create account
                </Link>
              </p>
            </div>

            <AuthLegalLine />
          </>
        )}
      </AuthStepTransition>
    </AuthShell>
  );
}
