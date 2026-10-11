import { Fingerprint } from 'lucide-react';

/**
 * Sign-in buttons that sit beside <GoogleButton> in AuthParts.tsx and share
 * its look: Apple (OAuth) and Passkey (WebAuthn).
 */

const BUTTON_CLASS =
  'focus-ring group flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-border bg-bg-primary text-sm font-semibold text-text-primary transition-all duration-200 hover:border-accent/30 hover:bg-bg-tertiary hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-60';

function Spinner() {
  return (
    <svg className="animate-spin text-text-secondary" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16.365 1.43c0 1.14-.46 2.22-1.2 3.01-.8.86-2.1 1.52-3.16 1.43-.13-1.1.42-2.25 1.15-3.01.81-.85 2.2-1.49 3.21-1.43zM20.9 17.3c-.55 1.27-.82 1.84-1.53 2.96-.99 1.57-2.39 3.52-4.12 3.54-1.54.02-1.94-1-4.03-.99-2.09.01-2.53 1.01-4.07.99-1.73-.02-3.05-1.78-4.04-3.35C.38 16.1.09 11.3 1.8 8.67c1.21-1.87 3.12-2.97 4.92-2.97 1.83 0 2.98 1.01 4.49 1.01 1.47 0 2.36-1.01 4.48-1.01 1.6 0 3.3.87 4.51 2.38-3.96 2.17-3.32 7.82.7 9.22z" />
    </svg>
  );
}

interface ButtonProps {
  onClick: () => void;
  loading: boolean;
  disabled: boolean;
  label: string;
}

export function AppleButton({ onClick, loading, disabled, label }: ButtonProps) {
  return (
    <button type="button" onClick={onClick} disabled={loading || disabled} className={BUTTON_CLASS}>
      {loading ? (
        <>
          <Spinner />
          <span>Connecting…</span>
        </>
      ) : (
        <>
          <AppleIcon />
          <span>{label}</span>
        </>
      )}
    </button>
  );
}

export function PasskeyButton({ onClick, loading, disabled, label }: ButtonProps) {
  return (
    <button type="button" onClick={onClick} disabled={loading || disabled} className={BUTTON_CLASS}>
      {loading ? (
        <>
          <Spinner />
          <span>Waiting for your passkey…</span>
        </>
      ) : (
        <>
          <Fingerprint size={18} aria-hidden="true" />
          <span>{label}</span>
        </>
      )}
    </button>
  );
}
