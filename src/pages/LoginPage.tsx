import { useState, FormEvent, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Mail, ArrowRight, Loader as Loader2, Phone } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { ThemeToggle } from '@/components/ThemeToggle';
import { BackButton } from '@/components/BackButton';
import { SARAH_PHONE } from '@/lib/site';
import { supabase } from '@/lib/supabase';

type Step = 'email' | 'otp';

export function LoginPage() {
  const navigate = useNavigate();
  const { session, loading } = useAuth();
  const { toast } = useToast();

  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  useEffect(() => {
    if (!loading && session) navigate('/dashboard', { replace: true });
  }, [session, loading, navigate]);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  const handleSendOtp = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast('Please enter a valid email address.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({ email: email.trim() });
      if (error) throw error;
      setStep('otp');
      setResendCooldown(60);
      toast('Check your inbox for the login code.', 'info');
    } catch {
      toast('Could not send login code. Please try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerifyOtp = async (e: FormEvent) => {
    e.preventDefault();
    if (!otp.trim() || otp.trim().length < 6) {
      toast('Please enter the 6-digit code.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const { error } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token: otp.trim(),
        type: 'email',
      });
      if (error) throw error;
      toast('Welcome to Vireek!', 'success');
      navigate('/dashboard', { replace: true });
    } catch {
      toast('Invalid or expired code. Try again or request a new one.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResend = async () => {
    if (resendCooldown > 0) return;
    setSubmitting(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({ email: email.trim() });
      if (error) throw error;
      setResendCooldown(60);
      toast('New code sent. Check your inbox.', 'info');
    } catch {
      toast('Could not resend code. Please try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-noise bg-gradient-mesh px-6">
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-bg-primary via-bg-primary to-bg-secondary" />

      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-4">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-white">
              <Phone size={16} strokeWidth={2.5} />
            </span>
            <span className="text-lg font-bold tracking-tight text-accent">Vireek</span>
          </Link>
          <BackButton fallback="/" />
        </div>
        <ThemeToggle />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-md"
      >
        <div className="rounded-2xl border border-border bg-bg-secondary/90 p-8 shadow-card backdrop-blur-md dark:shadow-card-dark md:p-10">
          <div className="text-center">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
              <Mail size={24} />
            </span>
            <h1 className="mt-5 text-2xl font-bold tracking-tight text-text-primary md:text-3xl">
              {step === 'email' ? 'Sign in to Vireek' : 'Enter your code'}
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-text-secondary">
              {step === 'email'
                ? "Enter your email and we'll send you a one-time login code."
                : `We sent a 6-digit code to ${email}. Enter it below to continue.`}
            </p>
          </div>

          <AnimatePresence mode="wait">
            {step === 'email' ? (
              <motion.form
                key="email"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                onSubmit={handleSendOtp}
                className="mt-8"
              >
                <label htmlFor="email" className="mb-2 block text-sm font-medium text-text-primary">
                  Email address
                </label>
                <input
                  id="email"
                  type="email"
                  autoFocus
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary placeholder:text-text-secondary/60 transition-colors focus-visible:border-accent"
                />
                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  disabled={submitting}
                  className="mt-5 w-full"
                >
                  {submitting ? (
                    <>
                      <Loader2 size={18} className="animate-spin" />
                      Sending code…
                    </>
                  ) : (
                    <>
                      Send login code
                      <ArrowRight size={18} />
                    </>
                  )}
                </Button>
              </motion.form>
            ) : (
              <motion.form
                key="otp"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                onSubmit={handleVerifyOtp}
                className="mt-8"
              >
                <label htmlFor="otp" className="mb-2 block text-sm font-medium text-text-primary">
                  Login code
                </label>
                <input
                  id="otp"
                  type="text"
                  inputMode="numeric"
                  autoFocus
                  maxLength={6}
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-center text-2xl font-bold tracking-[0.5em] text-text-primary placeholder:text-text-secondary/40 transition-colors focus-visible:border-accent"
                />
                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  disabled={submitting}
                  className="mt-5 w-full"
                >
                  {submitting ? (
                    <>
                      <Loader2 size={18} className="animate-spin" />
                      Verifying…
                    </>
                  ) : (
                    <>
                      Verify and continue
                      <ArrowRight size={18} />
                    </>
                  )}
                </Button>

                <div className="mt-5 flex items-center justify-between text-sm">
                  <button
                    type="button"
                    onClick={() => {
                      setStep('email');
                      setOtp('');
                    }}
                    className="focus-ring rounded text-text-secondary transition-colors hover:text-text-primary"
                  >
                    Use a different email
                  </button>
                  <button
                    type="button"
                    onClick={handleResend}
                    disabled={resendCooldown > 0 || submitting}
                    className="focus-ring rounded font-medium text-accent transition-colors hover:underline disabled:opacity-50"
                  >
                    {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
                  </button>
                </div>
              </motion.form>
            )}
          </AnimatePresence>

          <div className="mt-8 border-t border-border pt-6 text-center">
            <p className="text-sm text-text-secondary">
              New to Vireek? Your account is created automatically when you sign in.
            </p>
            <p className="mt-4 text-sm text-text-secondary">
              Prefer to call? Reach Sarah at{' '}
              <a href={SARAH_PHONE} className="font-semibold text-accent hover:underline">
                +1 (650) 910-6703
              </a>
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
