import { forwardRef, InputHTMLAttributes, ReactNode, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Eye, EyeOff, AlertCircle, Check, ArrowLeft } from 'lucide-react';
import { useTheme } from '@/contexts/ThemeContext';
import { Link } from 'react-router-dom';

/* ------------------------------------------------------------------ */
/*  Shared logo                                                        */
/* ------------------------------------------------------------------ */

export function AuthLogo({ size = 'h-12 w-12' }: { size?: string }) {
  const { theme } = useTheme();
  return (
    <span className={`relative block ${size}`}>
      <img
        src="/assets/logos/logo-dark.png.png"
        alt="Vireek"
        width={48}
        height={48}
        decoding="async"
        loading="eager"
        className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-200 ${
          theme === 'light' ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <img
        src="/assets/logos/logo-light.png.png"
        alt=""
        aria-hidden="true"
        width={48}
        height={48}
        decoding="async"
        loading="eager"
        className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-200 ${
          theme === 'dark' ? 'opacity-100' : 'opacity-0'
        }`}
      />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Google icon                                                        */
/* ------------------------------------------------------------------ */

export function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Premium input field                                                */
/* ------------------------------------------------------------------ */

type AuthInputProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  icon: React.ReactNode;
  error?: string;
  touched?: boolean;
  isValid?: boolean;
  showPasswordToggle?: boolean;
  hint?: React.ReactNode;
};

export const AuthInput = forwardRef<HTMLInputElement, AuthInputProps>(
  (
    {
      label,
      icon,
      error,
      touched,
      isValid,
      showPasswordToggle,
      hint,
      type = 'text',
      id,
      className = '',
      ...props
    },
    ref
  ) => {
    const [showPw, setShowPw] = useState(false);
    const inputType = showPasswordToggle ? (showPw ? 'text' : 'password') : type;
    const showError = !!error && touched;
    const showSuccess = isValid && touched && !error;

    return (
      <div>
        <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">
          {label}
        </label>
        <div className="relative">
          <span
            className={`pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 transition-colors duration-200 ${
              showError
                ? 'text-danger'
                : showSuccess
                  ? 'text-success-500'
                  : 'text-text-secondary/50'
            }`}
          >
            {icon}
          </span>
          <input
            ref={ref}
            id={id}
            type={inputType}
            className={`focus-ring w-full rounded-xl border bg-bg-primary py-3 pl-11 text-base text-text-primary transition-all duration-200 placeholder:text-text-secondary/50 ${
              showPasswordToggle ? 'pr-11' : 'pr-4'
            } ${
              showError
                ? 'border-danger/50 focus-visible:border-danger'
                : showSuccess
                  ? 'border-success-500/50 focus-visible:border-success-500'
                  : 'border-border focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_rgb(var(--accent-primary)/0.08)]'
            } ${className}`}
            aria-invalid={showError || undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            {...props}
          />
          {showPasswordToggle && (
            <button
              type="button"
              onClick={() => setShowPw((v) => !v)}
              aria-label={showPw ? 'Hide password' : 'Show password'}
              className="focus-ring absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1 text-text-secondary/60 transition-colors hover:text-text-primary"
            >
              {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          )}
          <AnimatePresence>
            {showSuccess && !showPasswordToggle && (
              <motion.span
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 400, damping: 20 }}
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-success-500"
              >
                <Check size={18} />
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        <AnimatePresence>
          {showError && (
            <motion.p
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.15 }}
              id={`${id}-error`}
              className="mt-1.5 flex items-center gap-1.5 text-xs text-danger"
              role="alert"
            >
              <AlertCircle size={12} className="shrink-0" />
              {error}
            </motion.p>
          )}
        </AnimatePresence>
        {hint && !showError && <div className="mt-1.5">{hint}</div>}
      </div>
    );
  }
);

AuthInput.displayName = 'AuthInput';

/* ------------------------------------------------------------------ */
/*  Auth shell — split-screen layout                                   */
/* ------------------------------------------------------------------ */

export function AuthShell({
  children,
  side,
}: {
  children: React.ReactNode;
  side: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen overflow-hidden bg-bg-primary">
      {/* Left side — form */}
      <div className="relative flex w-full flex-col lg:w-[480px] lg:shrink-0">
        {/* Top bar */}
        <div className="flex items-center justify-between px-6 py-5 sm:px-8">
          <Link to="/" className="flex items-center gap-2.5">
            <AuthLogo size="h-10 w-10" />
            <span className="text-lg font-bold tracking-tight text-accent">Vireek</span>
          </Link>
          {/* ThemeToggle is injected by the page via children to avoid circular imports */}
        </div>

        {/* Form area */}
        <div className="flex flex-1 items-center justify-center px-6 pb-12 sm:px-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="w-full max-w-[400px]"
          >
            {children}
          </motion.div>
        </div>
      </div>

      {/* Right side — visual */}
      <div className="relative hidden lg:block lg:flex-1">
        {side}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Auth side panel — the visual right column                          */
/* ------------------------------------------------------------------ */

export function AuthSidePanel() {
  return (
    <div className="relative h-full overflow-hidden bg-gradient-mesh bg-noise">
      <div className="absolute inset-0 bg-gradient-to-br from-accent-900/40 via-bg-secondary to-bg-tertiary" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(circle at 30% 20%, rgb(var(--accent-primary) / 0.12), transparent 50%), radial-gradient(circle at 70% 80%, rgb(var(--accent-secondary) / 0.08), transparent 50%)',
        }}
      />
      <div className="relative flex h-full flex-col justify-center px-16">
        <motion.div
          initial={{ opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1], delay: 0.2 }}
          className="max-w-md"
        >
          {/* Floating call card mockup */}
          <div className="rounded-2xl border border-border/60 bg-bg-secondary/60 p-6 shadow-2xl backdrop-blur-md">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
                </svg>
              </span>
              <div>
                <p className="text-sm font-semibold text-text-primary">Incoming call</p>
                <p className="text-xs text-text-secondary">Sarah is answering…</p>
              </div>
              <span className="ml-auto flex h-2 w-2">
                <span className="absolute inline-flex h-2 w-2 animate-ping rounded-full bg-success-500 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success-500" />
              </span>
            </div>
            <div className="mt-4 space-y-2">
              {['Caller identified and greeted', 'Service need qualified', 'Appointment booked — confirmed via SMS'].map((step, i) => (
                <motion.div
                  key={step}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.5 + i * 0.15, duration: 0.4 }}
                  className="flex items-center gap-2 rounded-lg border border-border/40 bg-bg-tertiary/50 px-3 py-2"
                >
                  <Check size={14} className="shrink-0 text-success-500" />
                  <span className="text-xs text-text-secondary">{step}</span>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Trust headline */}
          <h2 className="mt-10 text-2xl font-bold tracking-tight text-text-primary">
            Every call answered.
            <br />
            <span className="text-accent">Every opportunity captured.</span>
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-text-secondary">
            Vireek&rsquo;s AI receptionist handles your calls 24/7 — booking jobs, capturing leads,
            and following up automatically. Start free in under two minutes.
          </p>

          {/* Trust badges */}
          <div className="mt-8 flex flex-wrap gap-x-6 gap-y-3">
            {[
              { icon: 'shield', label: 'SOC 2 aligned' },
              { icon: 'lock', label: 'Encrypted at rest' },
              { icon: 'check', label: 'No card required' },
            ].map((badge) => (
              <div key={badge.label} className="flex items-center gap-2 text-xs font-medium text-text-secondary/70">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent/10 text-accent">
                  {badge.icon === 'shield' && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>}
                  {badge.icon === 'lock' && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>}
                  {badge.icon === 'check' && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}
                </span>
                {badge.label}
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Animated banner (error / success)                                  */
/* ------------------------------------------------------------------ */

export function AuthBanner({
  type,
  message,
  onDismiss,
}: {
  type: 'error' | 'success';
  message: string;
  onDismiss?: () => void;
}) {
  const isError = type === 'error';
  return (
    <motion.div
      initial={{ opacity: 0, height: 0, marginBottom: 0 }}
      animate={{ opacity: 1, height: 'auto', marginBottom: 16 }}
      exit={{ opacity: 0, height: 0, marginBottom: 0 }}
      transition={{ duration: 0.2 }}
      className="overflow-hidden"
    >
      <div
        className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${
          isError
            ? 'border-danger/30 bg-danger/5'
            : 'border-success-500/30 bg-success-500/5'
        }`}
      >
        {isError ? (
          <AlertCircle size={18} className="mt-0.5 shrink-0 text-danger" />
        ) : (
          <Check size={18} className="mt-0.5 shrink-0 text-success-500" />
        )}
        <p
          className={`flex-1 text-sm leading-relaxed ${
            isError ? 'text-danger' : 'text-success-500'
          }`}
        >
          {message}
        </p>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className={`focus-ring shrink-0 rounded p-0.5 transition-colors ${
              isError ? 'text-danger/70 hover:text-danger' : 'text-success-500/70 hover:text-success-500'
            }`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        )}
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Divider                                                            */
/* ------------------------------------------------------------------ */

export function AuthDivider() {
  return (
    <div className="my-6 flex items-center gap-4">
      <span className="h-px flex-1 bg-border" />
      <span className="text-xs font-medium uppercase tracking-wider text-text-secondary/60">
        or
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Google button                                                      */
/* ------------------------------------------------------------------ */

export function GoogleButton({
  onClick,
  loading,
  disabled,
  label,
}: {
  onClick: () => void;
  loading: boolean;
  disabled: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading || disabled}
      className="focus-ring group flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-border bg-bg-primary text-sm font-semibold text-text-primary transition-all duration-200 hover:border-accent/30 hover:bg-bg-tertiary hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-60"
    >
      {loading ? (
        <>
          <svg className="animate-spin text-text-secondary" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
          <span>Connecting…</span>
        </>
      ) : (
        <>
          <GoogleIcon />
          <span>{label}</span>
        </>
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Premium submit button                                              */
/* ------------------------------------------------------------------ */

export function AuthSubmitButton({
  loading,
  disabled,
  label,
  loadingLabel,
}: {
  loading: boolean;
  disabled: boolean;
  label: string;
  loadingLabel: string;
}) {
  return (
    <button
      type="submit"
      disabled={loading || disabled}
      className="focus-ring group relative mt-6 flex h-12 w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-accent text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:brightness-110 hover:shadow-glow-accent active:brightness-90 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100 disabled:hover:shadow-sm"
    >
      {loading ? (
        <>
          <svg className="animate-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
          {loadingLabel}
        </>
      ) : (
        <>
          {label}
          <svg className="transition-transform duration-200 group-hover:translate-x-0.5" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
        </>
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Legal line                                                         */
/* ------------------------------------------------------------------ */

export function AuthLegalLine() {
  return (
    <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-xs leading-relaxed text-text-secondary/60">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
      <span>
        By continuing, you agree to our{' '}
        <Link to="/terms" className="font-medium text-text-secondary transition-colors hover:text-accent hover:underline">
          Terms of Service
        </Link>{' '}
        and{' '}
        <Link to="/privacy" className="font-medium text-text-secondary transition-colors hover:text-accent hover:underline">
          Privacy Policy
        </Link>
        .
      </span>
    </p>
  );
}

/* ------------------------------------------------------------------ */
/*  Step transition — shared slide/fade wrapper for multi-step auth    */
/*  flows (signup verification, forgot-password, etc.)                 */
/* ------------------------------------------------------------------ */

export function AuthStepTransition({
  stepKey,
  children,
}: {
  stepKey: string;
  children: ReactNode;
}) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={stepKey}
        initial={{ opacity: 0, x: 16 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -16 }}
        transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

/* ------------------------------------------------------------------ */
/*  Back link — used to step back within a multi-step auth flow        */
/* ------------------------------------------------------------------ */

export function AuthBackLink({ onClick, label = 'Back' }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring group mb-5 flex items-center gap-1.5 rounded text-sm font-medium text-text-secondary transition-colors hover:text-accent"
    >
      <ArrowLeft size={15} className="transition-transform duration-200 group-hover:-translate-x-0.5" />
      {label}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Verification icon badge — used above the OTP step heading          */
/* ------------------------------------------------------------------ */

export function AuthIconBadge({ icon }: { icon: ReactNode }) {
  return (
    <motion.span
      initial={{ scale: 0.6, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 340, damping: 22 }}
      className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent"
    >
      {icon}
    </motion.span>
  );
}
