import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { captureResourceLead, writeUnlock } from '@/lib/resourceLeads';
import { isValidEmail } from '@/lib/resources';
import type { CaptureFailure } from '@/lib/resources';

const CAPTURE_ERRORS: Record<CaptureFailure, string> = {
  invalid_email: 'Enter a valid email address.',
  rate_limited: 'Too many requests. Please try again in a few minutes.',
  network: "We couldn't reach the server. Check your connection and try again.",
  unknown: 'Something went wrong. Please try again.',
};

interface ResourceGateProps {
  resourceSlug: string;
  resourceTitle: string;
  onUnlocked: () => void;
}

export function ResourceGate({ resourceSlug, resourceTitle, onUnlocked }: ResourceGateProps) {
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState(''); // honeypot
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (status === 'loading') return;

    if (company.trim()) {
      // Bot filled the hidden field: show the content, store nothing.
      onUnlocked();
      return;
    }
    if (!isValidEmail(email)) {
      setStatus('error');
      setMessage(CAPTURE_ERRORS.invalid_email);
      inputRef.current?.focus();
      return;
    }

    setStatus('loading');
    setMessage(null);
    const result = await captureResourceLead(email, resourceSlug);
    if (!result.ok) {
      setStatus('error');
      setMessage(CAPTURE_ERRORS[result.reason]);
      return;
    }
    writeUnlock();
    onUnlocked();
  };

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="rounded-2xl border border-border bg-bg-secondary p-6 sm:p-8"
      aria-labelledby="resource-gate-title"
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
        <Lock size={20} aria-hidden="true" />
      </span>
      <h2 id="resource-gate-title" className="mt-4 text-xl font-bold text-text-primary">
        Get free access to {resourceTitle}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-text-secondary">
        Enter your email to unlock this resource and every other one in the library. We'll also send occasional tips
        for home service businesses.
      </p>

      <div className="mt-5 space-y-4">
        <Input
          ref={inputRef}
          label="Email address"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@company.com"
          value={email}
          error={status === 'error' ? (message ?? undefined) : undefined}
          onChange={(e) => {
            setEmail(e.target.value);
            if (status === 'error') {
              setStatus('idle');
              setMessage(null);
            }
          }}
        />

        {/* Honeypot: hidden from people and assistive tech; bots fill it. */}
        <div className="absolute -left-[9999px] h-0 w-0 overflow-hidden" aria-hidden="true">
          <label>
            Company
            <input
              type="text"
              name="company"
              tabIndex={-1}
              autoComplete="off"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
            />
          </label>
        </div>

        <Button type="submit" size="lg" className="w-full" disabled={status === 'loading'}>
          {status === 'loading' ? 'Unlocking…' : 'Unlock free access'}
        </Button>
      </div>

      <p className="mt-4 text-xs leading-relaxed text-text-secondary">
        By continuing you agree to receive occasional emails from Vireek. Unsubscribe any time. See our{' '}
        <Link to="/privacy" className="font-medium text-accent hover:underline">
          Privacy Policy
        </Link>
        .
      </p>
    </form>
  );
}
