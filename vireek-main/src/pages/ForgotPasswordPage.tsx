import { useState, FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { ArrowLeft, KeyRound, Mail } from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { supabase } from '@/lib/supabase';
import {
  AuthShell,
  AuthSidePanel,
  AuthInput,
  AuthBanner,
  AuthSubmitButton,
  AuthLegalLine,
  AuthIconBadge,
} from '@/components/auth/AuthParts';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Where Supabase redirects the user after they click the link in the reset
 * email. This value must also be added to
 * Supabase Dashboard → Authentication → URL Configuration → Redirect URLs
 * or Supabase will silently reject the redirect.
 *
 * Falls back to VITE_SITE_URL so staging/preview deployments can point at
 * their own origin without editing this file — in production (no env var
 * set) it resolves to the literal production URL as required.
 */
const RESET_PASSWORD_REDIRECT_URL = `${
  import.meta.env.VITE_SITE_URL ?? 'https://vireek.com'
}/reset-password`;

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [sent, setSent] = useState(false);

  const validateEmail = () => {
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
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setEmailTouched(true);
    setSubmitError('');

    if (!validateEmail()) return;
    // Belt-and-braces guard against double submission (button is already
    // disabled while submitting, but a fast double-click / double-Enter
    // could otherwise race two requests).
    if (submitting) return;

    setSubmitting(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: RESET_PASSWORD_REDIRECT_URL,
      });
      if (error) throw error;
      // Supabase does not reveal whether the email is registered (this
      // call "succeeds" either way to prevent account enumeration), so we
      // always show the same success state.
      setSent(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Something went wrong. Please try again.';
      const lower = msg.toLowerCase();
      if (lower.includes('rate') || lower.includes('too many') || lower.includes('security purposes')) {
        setSubmitError("You've requested too many reset emails. Please wait a few minutes and try again.");
      } else if (lower.includes('invalid')) {
        setSubmitError('Please enter a valid email address.');
      } else {
        setSubmitError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell side={<AuthSidePanel />}>
      <div className="absolute right-6 top-5 sm:right-8">
        <ThemeToggle />
      </div>

      {sent ? (
        <div className="flex flex-col items-center text-center">
          <AuthIconBadge icon={<Mail size={22} />} />
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Check your email</h1>
          <p className="mx-auto mt-1.5 max-w-[320px] text-sm leading-relaxed text-text-secondary">
            Check your email. We sent you a password reset link.
          </p>

          <div className="mt-6 w-full rounded-xl border border-border bg-bg-secondary/50 p-4">
            <p className="text-sm text-text-secondary">
              Sent to <span className="font-semibold text-text-primary">{email.trim()}</span>
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-text-secondary/70">
              The link works even if you open it on a different device or browser than the one you
              requested it from. It expires after a while, so use it soon.
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              setSent(false);
              setSubmitError('');
            }}
            className="focus-ring mt-6 rounded text-sm font-medium text-accent transition-colors hover:underline"
          >
            Didn&rsquo;t get it? Try a different email
          </button>

          <div className="mt-8 w-full border-t border-border pt-6 text-center">
            <Link
              to="/login"
              className="focus-ring inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary transition-colors hover:text-accent"
            >
              <ArrowLeft size={15} />
              Back to sign in
            </Link>
          </div>
        </div>
      ) : (
        <>
          <div className="mb-8 flex flex-col items-start text-left">
            <AuthIconBadge icon={<KeyRound size={22} />} />
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">
              Forgot your password?
            </h1>
            <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">
              Enter the email address on your Vireek account and we&rsquo;ll send you a link to
              reset your password.
            </p>
          </div>

          <AnimatePresence>
            {submitError && (
              <AuthBanner type="error" message={submitError} onDismiss={() => setSubmitError('')} />
            )}
          </AnimatePresence>

          <form onSubmit={handleSubmit} noValidate className="space-y-4">
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
              onBlur={() => {
                setEmailTouched(true);
                validateEmail();
              }}
              placeholder="you@company.com"
              error={emailError}
              touched={emailTouched}
              isValid={EMAIL_REGEX.test(email.trim())}
            />

            <AuthSubmitButton
              loading={submitting}
              disabled={submitting}
              label="Send reset link"
              loadingLabel="Sending…"
            />
          </form>

          <div className="mt-8 border-t border-border pt-6 text-center">
            <Link
              to="/login"
              className="focus-ring inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary transition-colors hover:text-accent"
            >
              <ArrowLeft size={15} />
              Back to sign in
            </Link>
          </div>

          <AuthLegalLine />
        </>
      )}
    </AuthShell>
  );
}
