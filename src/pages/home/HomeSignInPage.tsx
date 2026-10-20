import { useEffect, useState, type FormEvent } from 'react';
import { requestOtp, verifyOtp } from '@/lib/homeowner/api';
import { isOtp, toE164 } from '@/lib/homeowner/format';
import { getPublicOrigin } from '@/lib/appOrigin';
import { ErrorNote, PrimaryButton, SecondaryButton } from './ui';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-3 text-base text-text-primary placeholder:text-text-secondary';

export function HomeSignInPage() {
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phoneInput, setPhoneInput] = useState('');
  const [e164, setE164] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const phone = toE164(phoneInput);
    if (!phone) {
      setError('Enter a valid mobile number, e.g. (555) 123-4567, or include your country code like +44 7700 900123.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await requestOtp(phone);
      setE164(phone);
      setStep('code');
      setCode('');
      setCooldown(30);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We couldn’t send a code.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value: string) => {
    if (!e164 || !isOtp(value) || busy) return;
    setBusy(true);
    setError(null);
    try {
      await verifyOtp(e164, value);
      // Success: the auth listener in HomeownerAuthProvider takes over.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code didn’t work.');
      setCode('');
      setBusy(false);
    }
  };

  const origin = getPublicOrigin();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-5 py-10">
      <h1 className="text-2xl font-semibold text-text-primary">Vireek Home</h1>
      <p className="mt-1 text-sm text-text-secondary">
        All your home services in one place. Sign in with your mobile number — no password.
      </p>

      {step === 'phone' ? (
        <form onSubmit={send} className="mt-6 space-y-4" noValidate>
          <label className="block text-sm font-medium text-text-primary" htmlFor="home-phone">
            Mobile number
          </label>
          <input
            id="home-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="(555) 123-4567"
            value={phoneInput}
            onChange={(e) => setPhoneInput(e.target.value)}
            className={inputClass}
          />
          {error && <ErrorNote message={error} />}
          <PrimaryButton type="submit" busy={busy} className="w-full">Send code</PrimaryButton>
          <p className="text-xs text-text-secondary">
            We’ll text you a 6-digit code. Message and data rates may apply. By continuing you agree to the{' '}
            <a className="underline" href={`${origin}/terms`} target="_blank" rel="noreferrer">Terms</a> and{' '}
            <a className="underline" href={`${origin}/privacy`} target="_blank" rel="noreferrer">Privacy Policy</a>.
          </p>
        </form>
      ) : (
        <div className="mt-6 space-y-4">
          <label className="block text-sm font-medium text-text-primary" htmlFor="home-code">
            Enter the 6-digit code sent to {e164}
          </label>
          <input
            id="home-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="123456"
            value={code}
            onChange={(e) => {
              const next = e.target.value.replace(/\D/g, '').slice(0, 6);
              setCode(next);
              if (next.length === 6) void verify(next);
            }}
            className={`${inputClass} text-center text-2xl tracking-[0.4em]`}
          />
          {error && <ErrorNote message={error} />}
          <PrimaryButton busy={busy} onClick={() => void verify(code)} disabled={!isOtp(code)} className="w-full">
            Verify
          </PrimaryButton>
          <div className="flex gap-2">
            <SecondaryButton className="flex-1" disabled={cooldown > 0 || busy} onClick={() => void send()}>
              {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
            </SecondaryButton>
            <SecondaryButton
              className="flex-1"
              onClick={() => {
                setStep('phone');
                setError(null);
              }}
            >
              Change number
            </SecondaryButton>
          </div>
        </div>
      )}
    </main>
  );
}
