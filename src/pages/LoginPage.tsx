import { useState, FormEvent, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { Mail, Lock } from 'lucide-react';
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
} from '@/components/auth/AuthParts';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginPage() {
  const navigate = useNavigate();
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
    <AuthShell side={<AuthSidePanel />}>
      {/* Theme toggle in top-right of form side */}
      <div className="absolute right-6 top-5 sm:right-8">
        <ThemeToggle />
      </div>

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
        {authError && (
          <AuthBanner type="error" message={authError} onDismiss={() => setAuthError('')} />
        )}
        {showSuccess && (
          <AuthBanner type="success" message="Signed in successfully! Redirecting…" />
        )}
      </AnimatePresence>

      {/* Form */}
      <form onSubmit={handleSignIn} noValidate className="space-y-4">
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
          <button
            type="button"
            onClick={handleForgotPassword}
            className="focus-ring rounded text-sm font-medium text-accent transition-colors hover:underline"
          >
            Forgot password?
          </button>
        </div>

        <AuthSubmitButton
          loading={submitting}
          disabled={googleLoading || !isFormValid}
          label="Sign In"
          loadingLabel="Signing in…"
        />
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
    </AuthShell>
  );
}
