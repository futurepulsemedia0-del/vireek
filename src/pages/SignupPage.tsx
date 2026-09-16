import { useState, FormEvent, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Mail, Lock, User, Check, X, MailCheck } from 'lucide-react';
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
import { registerTrustedDevice } from '@/lib/deviceTrust';
import { consumePostAuthRedirect } from '@/lib/inviteRedirect';

type SignupStep = 'form' | 'verify';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

export function SignupPage() {
  const navigate = useNavigate();
  const { session, loading } = useAuth();
  const { toast } = useToast();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [agreeTerms, setAgreeTerms] = useState(false);

  const [nameTouched, setNameTouched] = useState(false);
  const [emailTouched, setEmailTouched] = useState(false);
  const [confirmTouched, setConfirmTouched] = useState(false);
  const [passwordTouched, setPasswordTouched] = useState(false);

  const [nameError, setNameError] = useState('');
  const [emailError, setEmailError] = useState('');
  const [confirmError, setConfirmError] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [authError, setAuthError] = useState('');
  const [showSuccess, setShowSuccess] = useState(false);

  const [step, setStep] = useState<SignupStep>('form');
  const [pendingEmail, setPendingEmail] = useState('');

  // Only auto-redirect on an existing session while we're still on the plain
  // form — once we're in the verify step we want to play the OTP success
  // animation ourselves before navigating (see handleOtpSuccess below).
  useEffect(() => {
    if (!loading && session && step === 'form') navigate(consumePostAuthRedirect(), { replace: true });
  }, [session, loading, step, navigate]);

  const validateName = useCallback(() => {
    if (fullName.trim().length < 2) {
      setNameError('Name must be at least 2 characters');
      return false;
    }
    setNameError('');
    return true;
  }, [fullName]);

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

  const validateConfirm = useCallback(() => {
    if (confirmPassword !== password) {
      setConfirmError('Passwords do not match');
      return false;
    }
    setConfirmError('');
    return true;
  }, [confirmPassword, password]);

  const strength = useMemo(() => getPasswordStrength(password), [password]);
  const hasMinLength = password.length >= 8;
  const hasNumber = /[0-9]/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);
  const passwordMeetsPolicy = hasMinLength && hasNumber && hasSymbol;

  const isFormValid =
    fullName.trim().length >= 2 &&
    EMAIL_REGEX.test(email.trim()) &&
    passwordMeetsPolicy &&
    confirmPassword === password &&
    agreeTerms;

  const handleNameBlur = () => {
    setNameTouched(true);
    validateName();
  };

  const handleEmailBlur = () => {
    setEmailTouched(true);
    validateEmail();
  };

  const handleConfirmBlur = () => {
    setConfirmTouched(true);
    validateConfirm();
  };

  const handleSignUp = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError('');

    const nameOk = validateName();
    const emailOk = validateEmail();
    const confirmOk = validateConfirm();

    if (!nameOk || !emailOk || !confirmOk) return;
    if (!passwordMeetsPolicy) {
      setAuthError('Password must be at least 8 characters with a number and a symbol.');
      return;
    }
    if (!agreeTerms) {
      setAuthError('Please agree to the Terms of Service and Privacy Policy.');
      return;
    }

    setSubmitting(true);
    try {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: { full_name: fullName.trim() },
          emailRedirectTo: `${window.location.origin}/dashboard`,
        },
      });
      if (error) throw error;

      if (data.user && !data.session) {
        // Email confirmation is required. Supabase's "Confirm signup" email
        // carries both a magic link (works instantly if opened on this same
        // device/browser — session syncs across tabs automatically) and a
        // 6-digit code (works anywhere, e.g. checking mail on your phone).
        setPendingEmail(email.trim());
        setStep('verify');
      } else if (data.session) {
        // No email confirmation required (e.g. disabled in the Supabase
        // dashboard) — the account is fully live immediately, so this
        // browser is by definition the first verified device for it.
        try {
          await registerTrustedDevice();
        } catch {
          /* Non-fatal: worst case this device gets asked for OTP on next login. */
        }
        setShowSuccess(true);
        toast('Welcome to Vireek!', 'success');
        setTimeout(() => navigate(consumePostAuthRedirect(), { replace: true }), 600);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sign up failed. Please try again.';
      setAuthError(
        msg.toLowerCase().includes('already')
          ? 'An account with this email already exists. Try signing in instead.'
          : msg
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerifyOtp = useCallback(
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
          /* Non-fatal: worst case this device gets asked for OTP on next login. */
        }
        toast('Welcome to Vireek!', 'success');
        return { success: true };
      } catch {
        return { success: false, error: 'Something went wrong verifying that code.' };
      }
    },
    [pendingEmail, toast]
  );

  const handleResendOtp = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    try {
      const { error } = await supabase.auth.resend({ type: 'signup', email: pendingEmail });
      if (error) return { success: false, error: error.message };
      return { success: true };
    } catch {
      return { success: false, error: "Couldn't resend the code. Try again shortly." };
    }
  }, [pendingEmail]);

  const handleOtpSuccess = useCallback(() => {
    // Send fresh signups through onboarding first (industry, team size,
    // hours, etc.) instead of dropping them straight on the dashboard —
    // the dashboard used to bounce them to /onboarding itself via a
    // useEffect once the profile loaded, which meant an extra render/
    // navigation hop right after auth state changed. Going there directly
    // removes that hop entirely.
    navigate('/onboarding', { replace: true });
  }, [navigate]);

  const handleGoogleSignUp = async () => {
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
      const msg = err instanceof Error ? err.message : 'Google sign-up failed.';
      setAuthError(
        msg.toLowerCase().includes('provider') || msg.toLowerCase().includes('not')
          ? 'Google sign-up is not configured. Please use email and password.'
          : msg
      );
    }
  };

  return (
    <AuthShell side={<AuthSidePanel />}>
      {/* Theme toggle */}
      <div className="absolute right-6 top-5 sm:right-8">
        <ThemeToggle />
      </div>

      <AuthStepTransition stepKey={step}>
      {step === 'verify' ? (
        <div className="flex flex-col items-center text-center">
          <AuthIconBadge icon={<MailCheck size={22} />} />
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Verify your email</h1>
          <p className="mx-auto mt-1.5 max-w-[320px] text-sm leading-relaxed text-text-secondary">
            We sent a 6-digit code and a confirmation link to{' '}
            <span className="font-semibold text-text-primary">{pendingEmail}</span>. Enter the
            code below — or open the link on this device and we&rsquo;ll sign you in
            automatically.
          </p>

          <div className="mt-8 w-full">
            <OtpEntry
              length={6}
              onVerify={handleVerifyOtp}
              onResend={handleResendOtp}
              externalSuccess={!!session}
              onSuccessSettled={handleOtpSuccess}
            />
          </div>

          <div className="mt-8">
            <AuthBackLink onClick={() => setStep('form')} label="Wrong email? Go back" />
          </div>
        </div>
      ) : (
        <>
      {/* Heading */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-text-primary">Create your account</h1>
        <p className="mt-1.5 text-sm text-text-secondary">
          Start your free trial — no credit card required. Set up in under two minutes.
        </p>
      </div>

      {/* Google */}
      <GoogleButton
        onClick={handleGoogleSignUp}
        loading={googleLoading}
        disabled={submitting}
        label="Sign up with Google"
      />

      <AuthDivider />

      {/* Banners */}
      <AnimatePresence>
        {authError && (
          <AuthBanner type="error" message={authError} onDismiss={() => setAuthError('')} />
        )}
        {showSuccess && (
          <AuthBanner
            type="success"
            message="Account created! Check your inbox for a verification link to continue."
          />
        )}
      </AnimatePresence>

      {/* Form */}
      <form onSubmit={handleSignUp} noValidate className="space-y-4">
        <AuthInput
          id="fullName"
          type="text"
          label="Full name"
          icon={<User size={18} />}
          autoComplete="name"
          autoFocus
          value={fullName}
          onChange={(e) => {
            setFullName(e.target.value);
            if (nameTouched) validateName();
          }}
          onBlur={handleNameBlur}
          placeholder="Jane Smith"
          error={nameError}
          touched={nameTouched}
          isValid={fullName.trim().length >= 2}
        />

        <AuthInput
          id="email"
          type="email"
          label="Email address"
          icon={<Mail size={18} />}
          autoComplete="email"
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

        {/* Password with strength meter */}
        <div>
          <AuthInput
            id="password"
            type="password"
            label="Password"
            icon={<Lock size={18} />}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onBlur={() => setPasswordTouched(true)}
            placeholder="Create a password"
            showPasswordToggle
            touched={passwordTouched}
            isValid={passwordMeetsPolicy}
            aria-describedby="password-requirements"
          />
          {password.length > 0 && (
            <div className="mt-2 flex items-center gap-2">
              <div className="flex h-1.5 flex-1 gap-1">
                {[0, 1, 2].map((i) => (
                  <motion.span
                    key={i}
                    initial={false}
                    animate={{
                      backgroundColor:
                        i <= (strength === 'weak' ? 0 : strength === 'medium' ? 1 : 2)
                          ? 'rgb(var(--accent-primary))'
                          : 'rgb(var(--border-default))',
                    }}
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
          <ul id="password-requirements" className="mt-2 space-y-1">
            {[
              { met: hasMinLength, label: 'At least 8 characters' },
              { met: hasNumber, label: 'At least one number' },
              { met: hasSymbol, label: 'At least one symbol (e.g. ! @ # $ %)' },
            ].map(({ met, label }) => (
              <li
                key={label}
                className={`flex items-center gap-1.5 text-xs transition-colors ${
                  met
                    ? 'text-success-500'
                    : passwordTouched
                      ? 'text-danger'
                      : 'text-text-secondary/60'
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

        {/* Confirm password */}
        <AuthInput
          id="confirmPassword"
          type="password"
          label="Confirm password"
          icon={<Lock size={18} />}
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => {
            setConfirmPassword(e.target.value);
            if (confirmTouched) validateConfirm();
          }}
          onBlur={handleConfirmBlur}
          placeholder="Re-enter your password"
          showPasswordToggle
          error={confirmError}
          touched={confirmTouched}
          isValid={confirmPassword === password && password.length > 0}
        />

        {/* Terms checkbox */}
        <div>
          <label className="flex cursor-pointer items-start gap-2.5 text-sm leading-relaxed text-text-secondary select-none">
            <input
              type="checkbox"
              checked={agreeTerms}
              onChange={(e) => setAgreeTerms(e.target.checked)}
              className="focus-ring mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-accent"
            />
            <span>
              I agree to the{' '}
              <Link
                to="/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-accent transition-colors hover:underline"
              >
                Terms of Service
              </Link>{' '}
              and{' '}
              <Link
                to="/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-accent transition-colors hover:underline"
              >
                Privacy Policy
              </Link>
              .
            </span>
          </label>
        </div>

        <AuthSubmitButton
          loading={submitting}
          disabled={googleLoading || !isFormValid}
          label="Create account"
          loadingLabel="Creating account…"
        />
      </form>

      {/* Footer */}
      <div className="mt-8 border-t border-border pt-6 text-center">
        <p className="text-sm text-text-secondary">
          Already have an account?{' '}
          <Link to="/login" className="font-semibold text-accent transition-colors hover:underline">
            Sign in
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
