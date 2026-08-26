import { useState, FormEvent, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Eye, EyeOff, Loader as Loader2, CircleAlert as AlertCircle, X, CircleCheck as CheckCircle2, Mail, Lock, ArrowRight } from 'lucide-react';
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

export function LoginPage() {
  const navigate = useNavigate();
  const { session, loading } = useAuth();
  const { toast } = useToast();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [emailTouched, setEmailTouched] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [authError, setAuthError] = useState('');
  const [showSuccess, setShowSuccess] = useState(false);

  useEffect(() => {
    if (!loading && session) navigate('/dashboard', { replace: true });
  }, [session, loading, navigate]);

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

      setShowSuccess(true);
      toast('Welcome back to Vireek!', 'success');
      setTimeout(() => navigate('/dashboard', { replace: true }), 600);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sign in failed. Please try again.';
      setAuthError(
        msg.toLowerCase().includes('invalid')
          ? 'Invalid email or password. Please try again.'
          : msg
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogleSignIn = async () => {
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
      const msg = err instanceof Error ? err.message : 'Google sign-in failed.';
      setAuthError(
        msg.toLowerCase().includes('provider') || msg.toLowerCase().includes('not')
          ? 'Google sign-in is not configured. Please use email and password.'
          : msg
      );
    }
  };

  const handleForgotPassword = async () => {
    if (!email.trim() || !EMAIL_REGEX.test(email.trim())) {
      toast('Enter your email address first, then click "Forgot password?"', 'info');
      return;
    }
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/dashboard`,
      });
      if (error) throw error;
      toast('Password reset link sent to your email.', 'success');
    } catch {
      toast('Could not send reset link. Please try again.', 'error');
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
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">Welcome back</h1>
            <p className="mt-2 text-sm leading-relaxed text-text-secondary">
              Sign in to your account
            </p>
          </div>

          {/* Google button */}
          <button
            type="button"
            onClick={handleGoogleSignIn}
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
                <span>Continue with Google</span>
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
                <div className="flex items-center gap-3 rounded-xl border border-success-500/30 bg-success-500/5 px-4 py-3">
                  <CheckCircle2 size={18} className="shrink-0 text-success-500" />
                  <p className="text-sm font-medium text-success-500">Signed in successfully!</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Email/password form */}
          <form onSubmit={handleSignIn} noValidate>
            {/* Email */}
            <div>
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
                  autoFocus
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
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
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
            </div>

            {/* Remember me + Forgot password */}
            <div className="mt-5 flex items-center justify-between">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-text-secondary select-none">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="h-4 w-4 rounded border-border accent-accent"
                />
                Remember me
              </label>
              <button
                type="button"
                onClick={handleForgotPassword}
                className="focus-ring rounded text-sm font-medium text-accent transition-colors hover:underline"
              >
                Forgot password?
              </button>
            </div>

            {/* Sign In button */}
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
                  Signing in…
                </>
              ) : (
                <>
                  Sign In
                  <ArrowRight size={18} />
                </>
              )}
            </Button>
          </form>

          {/* Footer */}
          <div className="mt-8 border-t border-border pt-6 text-center">
            <p className="text-sm text-text-secondary">
              Don't have an account?{' '}
              <Link
                to="/login"
                className="font-semibold text-accent transition-colors hover:underline"
              >
                Create account
              </Link>
            </p>
          </div>
        </div>

        {/* Legal line */}
        <p className="mt-5 text-center text-xs leading-relaxed text-text-secondary/60">
          By continuing, you agree to our{' '}
          <Link to="/terms" className="font-medium text-text-secondary transition-colors hover:text-accent hover:underline">
            Terms of Service
          </Link>{' '}
          and{' '}
          <Link to="/privacy" className="font-medium text-text-secondary transition-colors hover:text-accent hover:underline">
            Privacy Policy
          </Link>
          .
        </p>
      </motion.div>
    </div>
  );
}
