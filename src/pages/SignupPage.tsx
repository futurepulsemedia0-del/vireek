import { useState, FormEvent, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Eye,
  EyeOff,
  Loader as Loader2,
  CircleAlert as AlertCircle,
  X,
  CircleCheck as CheckCircle2,
  Mail,
  Lock,
  ArrowRight,
  User,
  ShieldCheck,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { ThemeToggle } from '@/components/ThemeToggle';
import { supabase } from '@/lib/supabase';
import { useTheme } from '@/contexts/ThemeContext';

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

function Logo() {
  const { theme } = useTheme();
  return (
    <span className="relative block h-12 w-12">
      <img
        src="/assets/logos/logo-dark.png.png"
        alt="Vireek"
        className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-200 ${
          theme === 'light' ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <img
        src="/assets/logos/logo-light.png.png"
        alt=""
        aria-hidden="true"
        className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-200 ${
          theme === 'dark' ? 'opacity-100' : 'opacity-0'
        }`}
      />
    </span>
  );
}

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
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [agreeTerms, setAgreeTerms] = useState(false);

  const [nameTouched, setNameTouched] = useState(false);
  const [emailTouched, setEmailTouched] = useState(false);
  const [confirmTouched, setConfirmTouched] = useState(false);

  const [nameError, setNameError] = useState('');
  const [emailError, setEmailError] = useState('');
  const [confirmError, setConfirmError] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [authError, setAuthError] = useState('');
  const [showSuccess, setShowSuccess] = useState(false);

  useEffect(() => {
    if (!loading && session) navigate('/dashboard', { replace: true });
  }, [session, loading, navigate]);

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
  const passwordMeetsPolicy = password.length >= 8 && /[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password);

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
        setShowSuccess(true);
        toast('Account created! Check your email to verify.', 'success');
      } else if (data.session) {
        setShowSuccess(true);
        toast('Welcome to Vireek!', 'success');
        setTimeout(() => navigate('/dashboard', { replace: true }), 600);
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

  const handleGoogleSignUp = async () => {
    setAuthError('');
    setGoogleLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/dashboard`,
        },
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
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-noise bg-gradient-mesh px-6 py-12">
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-bg-primary via-bg-primary to-bg-secondary" />

      {/* Top bar */}
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-6 py-4">
        <Link to="/" className="flex items-center gap-2.5">
          <Logo />
          <span className="text-lg font-bold tracking-tight text-accent">Vireek</span>
        </Link>
        <ThemeToggle />
      </div>

      {/* Card */}
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-[420px]"
      >
        <div className="rounded-2xl border border-border bg-bg-secondary/90 p-8 shadow-card backdrop-blur-md dark:shadow-card-dark md:p-10">
          {/* Logo + heading */}
          <div className="flex flex-col items-center text-center">
            <Link to="/" className="mb-5" aria-label="Vireek home">
              <Logo />
            </Link>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">
              Create your account
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-text-secondary">
              Start your free trial with Vireek
            </p>
          </div>

          {/* Google button */}
          <button
            type="button"
            onClick={handleGoogleSignUp}
            disabled={googleLoading || submitting}
            className="focus-ring mt-8 flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-border bg-bg-primary text-sm font-semibold text-text-primary transition-all hover:bg-bg-tertiary hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-60"
          >
            {googleLoading ? (
              <>
                <Loader2 size={20} className="animate-spin text-text-secondary" />
                <span>Connecting…</span>
              </>
            ) : (
              <>
                <GoogleIcon />
                <span>Sign up with Google</span>
              </>
            )}
          </button>

          {/* Divider */}
          <div className="my-6 flex items-center gap-4">
            <span className="h-px flex-1 bg-border" />
            <span className="text-xs font-medium uppercase tracking-wider text-text-secondary/60">
              OR
            </span>
            <span className="h-px flex-1 bg-border" />
          </div>

          {/* Error banner */}
          <AnimatePresence>
            {authError && (
              <motion.div
                initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                animate={{ opacity: 1, height: 'auto', marginBottom: 16 }}
                exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3">
                  <AlertCircle size={18} className="mt-0.5 shrink-0 text-danger" />
                  <p className="flex-1 text-sm leading-relaxed text-danger">{authError}</p>
                  <button
                    type="button"
                    onClick={() => setAuthError('')}
                    aria-label="Dismiss error"
                    className="focus-ring shrink-0 rounded p-0.5 text-danger/70 transition-colors hover:text-danger"
                  >
                    <X size={16} />
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Success banner */}
          <AnimatePresence>
            {showSuccess && (
              <motion.div
                initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                animate={{ opacity: 1, height: 'auto', marginBottom: 16 }}
                exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="flex items-start gap-3 rounded-xl border border-success-500/30 bg-success-500/5 px-4 py-3">
                  <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-success-500" />
                  <p className="flex-1 text-sm leading-relaxed text-success-500">
                    Account created! Check your inbox for a verification link to continue.
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Sign-up form */}
          <form onSubmit={handleSignUp} noValidate>
            {/* Full Name */}
            <div>
              <label
                htmlFor="fullName"
                className="mb-2 block text-sm font-medium text-text-primary"
              >
                Full name
              </label>
              <div className="relative">
                <User
                  size={18}
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-text-secondary/50"
                />
                <input
                  id="fullName"
                  type="text"
                  autoComplete="name"
                  autoFocus
                  value={fullName}
                  onChange={(e) => {
                    setFullName(e.target.value);
                    if (nameTouched) validateName();
                  }}
                  onBlur={handleNameBlur}
                  placeholder="Jane Smith"
                  aria-invalid={!!nameError}
                  aria-describedby={nameError ? 'name-error' : undefined}
                  className={`focus-ring w-full rounded-xl border bg-bg-primary py-3 pl-11 pr-4 text-base text-text-primary placeholder:text-text-secondary/50 transition-colors ${
                    nameError
                      ? 'border-danger/50 focus-visible:border-danger'
                      : 'border-border focus-visible:border-accent'
                  }`}
                />
              </div>
              {nameError && (
                <p id="name-error" className="mt-1.5 text-xs text-danger" role="alert">
                  {nameError}
                </p>
              )}
            </div>

            {/* Email */}
            <div className="mt-4">
              <label
                htmlFor="email"
                className="mb-2 block text-sm font-medium text-text-primary"
              >
                Email address
              </label>
              <div className="relative">
                <Mail
                  size={18}
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-text-secondary/50"
                />
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (emailTouched) validateEmail();
                  }}
                  onBlur={handleEmailBlur}
                  placeholder="you@company.com"
                  aria-invalid={!!emailError}
                  aria-describedby={emailError ? 'email-error' : undefined}
                  className={`focus-ring w-full rounded-xl border bg-bg-primary py-3 pl-11 pr-4 text-base text-text-primary placeholder:text-text-secondary/50 transition-colors ${
                    emailError
                      ? 'border-danger/50 focus-visible:border-danger'
                      : 'border-border focus-visible:border-accent'
                  }`}
                />
              </div>
              {emailError && (
                <p id="email-error" className="mt-1.5 text-xs text-danger" role="alert">
                  {emailError}
                </p>
              )}
            </div>

            {/* Password */}
            <div className="mt-4">
              <label
                htmlFor="password"
                className="mb-2 block text-sm font-medium text-text-primary"
              >
                Password
              </label>
              <div className="relative">
                <Lock
                  size={18}
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-text-secondary/50"
                />
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Create a password"
                  aria-describedby="password-help"
                  className="focus-ring w-full rounded-xl border border-border bg-bg-primary py-3 pl-11 pr-11 text-base text-text-primary placeholder:text-text-secondary/50 transition-colors focus-visible:border-accent"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="focus-ring absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 text-text-secondary/60 transition-colors hover:text-text-primary"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              {/* Strength indicator */}
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
              <p id="password-help" className="mt-1.5 text-xs text-text-secondary/60">
                Min 8 characters with at least one number and one symbol.
              </p>
            </div>

            {/* Confirm Password */}
            <div className="mt-4">
              <label
                htmlFor="confirmPassword"
                className="mb-2 block text-sm font-medium text-text-primary"
              >
                Confirm password
              </label>
              <div className="relative">
                <Lock
                  size={18}
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-text-secondary/50"
                />
                <input
                  id="confirmPassword"
                  type={showConfirm ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                    if (confirmTouched) validateConfirm();
                  }}
                  onBlur={handleConfirmBlur}
                  placeholder="Re-enter your password"
                  aria-invalid={!!confirmError}
                  aria-describedby={confirmError ? 'confirm-error' : undefined}
                  className={`focus-ring w-full rounded-xl border bg-bg-primary py-3 pl-11 pr-11 text-base text-text-primary placeholder:text-text-secondary/50 transition-colors ${
                    confirmError
                      ? 'border-danger/50 focus-visible:border-danger'
                      : 'border-border focus-visible:border-accent'
                  }`}
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm((v) => !v)}
                  aria-label={showConfirm ? 'Hide password' : 'Show password'}
                  className="focus-ring absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 text-text-secondary/60 transition-colors hover:text-text-primary"
                >
                  {showConfirm ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              {confirmError && (
                <p id="confirm-error" className="mt-1.5 text-xs text-danger" role="alert">
                  {confirmError}
                </p>
              )}
            </div>

            {/* Terms checkbox */}
            <div className="mt-5">
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

            {/* Create account button */}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={submitting || googleLoading || !isFormValid}
              className="mt-6 w-full gap-2"
            >
              {submitting ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  Creating account…
                </>
              ) : (
                <>
                  Create account
                  <ArrowRight size={18} />
                </>
              )}
            </Button>
          </form>

          {/* Footer */}
          <div className="mt-8 border-t border-border pt-6 text-center">
            <p className="text-sm text-text-secondary">
              Already have an account?{' '}
              <Link
                to="/login"
                className="font-semibold text-accent transition-colors hover:underline"
              >
                Sign in
              </Link>
            </p>
          </div>
        </div>

        {/* Legal line */}
        <p className="mt-5 flex items-center justify-center gap-1.5 text-center text-xs leading-relaxed text-text-secondary/60">
          <ShieldCheck size={14} className="shrink-0" />
          <span>
            By continuing, you agree to our{' '}
            <Link
              to="/terms"
              className="font-medium text-text-secondary transition-colors hover:text-accent hover:underline"
            >
              Terms of Service
            </Link>{' '}
            and{' '}
            <Link
              to="/privacy"
              className="font-medium text-text-secondary transition-colors hover:text-accent hover:underline"
            >
              Privacy Policy
            </Link>
            .
          </span>
        </p>
      </motion.div>
    </div>
  );
}
