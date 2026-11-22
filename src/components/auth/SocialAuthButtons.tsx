import { Fingerprint, Smartphone } from 'lucide-react';

/**
 * Sign-in buttons that sit beside <GoogleButton> in AuthParts.tsx and share
 * its look: Phone (SMS code) and Passkey (WebAuthn).
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


interface ButtonProps {
  onClick: () => void;
  loading: boolean;
  disabled: boolean;
  label: string;
}

export function PhoneButton({ onClick, disabled, label }: { onClick: () => void; disabled: boolean; label: string }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={BUTTON_CLASS}>
      <Smartphone size={18} aria-hidden="true" />
      <span>{label}</span>
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
