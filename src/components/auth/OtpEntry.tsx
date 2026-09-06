import {
  useCallback,
  useEffect,
  useRef,
  useState,
  ClipboardEvent,
  KeyboardEvent,
  ChangeEvent,
} from 'react';
import './otp-entry.css';

export type OtpStatus = 'idle' | 'verifying' | 'success' | 'error';

interface OtpEntryProps {
  /** Number of digit boxes. Default 6 (matches Supabase's default email OTP length). */
  length?: number;
  /**
   * Called once all boxes are filled. Return `{ success: true }` to play the
   * success animation, or `{ success: false, error }` to shake and show the
   * message. Throwing is treated the same as returning `success: false`.
   */
  onVerify: (code: string) => Promise<{ success: boolean; error?: string }>;
  /** Called when the person asks to resend the code. */
  onResend: () => Promise<{ success: boolean; error?: string }>;
  /** Seconds before "Resend code" becomes clickable again. Default 45. */
  resendCooldownSeconds?: number;
  /**
   * Set to true to jump straight to the success animation without the user
   * typing anything — e.g. when a magic link was clicked in another tab on
   * the same device and Supabase has already created a session for them.
   */
  externalSuccess?: boolean;
  /** Fired after the success animation has finished playing. Navigate here. */
  onSuccessSettled?: () => void;
  /** Small status line shown under the boxes when idle (e.g. "Enter the 6-digit code"). */
  idleHint?: string;
  autoFocus?: boolean;
}

const SUCCESS_SETTLE_MS = 900;
const ERROR_RESET_MS = 900;

export function OtpEntry({
  length = 6,
  onVerify,
  onResend,
  resendCooldownSeconds = 45,
  externalSuccess = false,
  onSuccessSettled,
  idleHint = 'Enter the 6-digit code',
  autoFocus = true,
}: OtpEntryProps) {
  const [digits, setDigits] = useState<string[]>(() => Array(length).fill(''));
  const [status, setStatus] = useState<OtpStatus>('idle');
  const [message, setMessage] = useState(idleHint);
  const [activeIndex, setActiveIndex] = useState<number | null>(autoFocus ? 0 : null);
  const [secondsLeft, setSecondsLeft] = useState(resendCooldownSeconds);
  const [resending, setResending] = useState(false);

  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const verifyingRef = useRef(false);
  const settledRef = useRef(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Countdown for resend.
  useEffect(() => {
    if (secondsLeft <= 0) return;
    const t = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [secondsLeft]);

  useEffect(() => {
    if (autoFocus) inputRefs.current[0]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const clearAndRefocus = useCallback(() => {
    setDigits(Array(length).fill(''));
    setActiveIndex(0);
    requestAnimationFrame(() => inputRefs.current[0]?.focus());
  }, [length]);

  const runVerify = useCallback(
    async (code: string) => {
      if (verifyingRef.current) return;
      verifyingRef.current = true;
      setStatus('verifying');
      setActiveIndex(null);
      try {
        const result = await onVerify(code);
        if (result.success) {
          setStatus('success');
          setMessage('Code verified');
          settledRef.current = false;
          setTimeout(() => {
            if (!settledRef.current) {
              settledRef.current = true;
              onSuccessSettled?.();
            }
          }, SUCCESS_SETTLE_MS);
        } else {
          setStatus('error');
          setMessage(result.error || "That code isn't right — try again.");
          resetTimerRef.current = setTimeout(() => {
            setStatus('idle');
            setMessage(idleHint);
            clearAndRefocus();
          }, ERROR_RESET_MS);
        }
      } catch {
        setStatus('error');
        setMessage('Something went wrong verifying that code. Try again.');
        resetTimerRef.current = setTimeout(() => {
          setStatus('idle');
          setMessage(idleHint);
          clearAndRefocus();
        }, ERROR_RESET_MS);
      } finally {
        verifyingRef.current = false;
      }
    },
    [onVerify, onSuccessSettled, idleHint, clearAndRefocus]
  );

  // External success (e.g. same-device magic link clicked in another tab).
  useEffect(() => {
    if (!externalSuccess) return;
    if (status === 'success') return;
    setDigits((prev) => (prev.every((d) => d) ? prev : Array(length).fill('•')));
    setStatus('success');
    setMessage('Verified — signing you in…');
    setActiveIndex(null);
    settledRef.current = false;
    const t = setTimeout(() => {
      if (!settledRef.current) {
        settledRef.current = true;
        onSuccessSettled?.();
      }
    }, SUCCESS_SETTLE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalSuccess]);

  const commit = useCallback(
    (next: string[]) => {
      setDigits(next);
      if (next.every((d) => d.length === 1)) {
        runVerify(next.join(''));
      }
    },
    [runVerify]
  );

  const handleChange = (idx: number) => (e: ChangeEvent<HTMLInputElement>) => {
    if (status === 'verifying' || status === 'success') return;
    if (status === 'error') {
      setStatus('idle');
      setMessage(idleHint);
    }
    const raw = e.target.value.replace(/[^0-9]/g, '');
    if (!raw) {
      const next = [...digits];
      next[idx] = '';
      commit(next);
      return;
    }
    // Handle fast mobile autofill dropping the whole code into one box.
    if (raw.length > 1) {
      const chars = raw.slice(0, length).split('');
      const next = Array(length).fill('');
      chars.forEach((c, i) => (next[i] = c));
      commit(next);
      const lastFilled = Math.min(chars.length, length - 1);
      setActiveIndex(lastFilled);
      inputRefs.current[lastFilled]?.focus();
      return;
    }
    const next = [...digits];
    next[idx] = raw;
    commit(next);
    if (idx < length - 1) {
      setActiveIndex(idx + 1);
      inputRefs.current[idx + 1]?.focus();
      inputRefs.current[idx + 1]?.select();
    }
  };

  const handleKeyDown = (idx: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (status === 'verifying' || status === 'success') return;
    if (e.key === 'Backspace') {
      if (!digits[idx] && idx > 0) {
        e.preventDefault();
        const next = [...digits];
        next[idx - 1] = '';
        setDigits(next);
        setActiveIndex(idx - 1);
        inputRefs.current[idx - 1]?.focus();
      } else if (digits[idx]) {
        const next = [...digits];
        next[idx] = '';
        setDigits(next);
      }
      if (status === 'error') {
        setStatus('idle');
        setMessage(idleHint);
      }
    } else if (e.key === 'ArrowLeft' && idx > 0) {
      e.preventDefault();
      setActiveIndex(idx - 1);
      inputRefs.current[idx - 1]?.focus();
    } else if (e.key === 'ArrowRight' && idx < length - 1) {
      e.preventDefault();
      setActiveIndex(idx + 1);
      inputRefs.current[idx + 1]?.focus();
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (status === 'verifying' || status === 'success') return;
    const text = e.clipboardData.getData('text') || '';
    const chars = text.replace(/[^0-9]/g, '').slice(0, length).split('');
    if (!chars.length) return;
    const next = Array(length).fill('');
    chars.forEach((c, i) => (next[i] = c));
    commit(next);
    const lastFilled = Math.min(chars.length, length - 1);
    setActiveIndex(lastFilled);
    inputRefs.current[lastFilled]?.focus();
  };

  const handleResend = async () => {
    if (secondsLeft > 0 || resending) return;
    setResending(true);
    try {
      const result = await onResend();
      if (result.success) {
        setMessage('New code sent — check your inbox');
        setSecondsLeft(resendCooldownSeconds);
        clearAndRefocus();
        setStatus('idle');
      } else {
        setMessage(result.error || "Couldn't resend the code. Try again shortly.");
      }
    } catch {
      setMessage("Couldn't resend the code. Try again shortly.");
    } finally {
      setResending(false);
    }
  };

  const boxesFilled = status === 'success';

  return (
    <div className={`vrk-authotp vrk-authotp--${status}`}>
      <div className="vrk-authotp-boxes" role="group" aria-label="One-time verification code">
        <span className="vrk-authotp-ripple" aria-hidden="true" />
        {digits.map((d, i) => (
          <div className="vrk-authotp-box-wrap" key={i}>
            {i === Math.floor(length / 2) && <span className="vrk-authotp-divider" aria-hidden="true" />}
            <div
              className={[
                'vrk-authotp-box',
                d && !boxesFilled ? 'vrk-authotp-box--filled' : '',
                activeIndex === i ? 'vrk-authotp-box--active' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <span className="vrk-authotp-caret" aria-hidden="true" />
              <input
                ref={(el) => (inputRefs.current[i] = el)}
                className="vrk-authotp-input"
                type="text"
                inputMode="numeric"
                autoComplete={i === 0 ? 'one-time-code' : 'off'}
                pattern="[0-9]*"
                maxLength={1}
                value={boxesFilled ? '' : d}
                disabled={status === 'verifying' || status === 'success'}
                onChange={handleChange(i)}
                onKeyDown={handleKeyDown(i)}
                onPaste={handlePaste}
                onFocus={() => setActiveIndex(i)}
                aria-label={`Digit ${i + 1} of ${length}`}
              />
              <svg className="vrk-authotp-check" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 12.5l4.5 4.5L19 7" />
              </svg>
            </div>
          </div>
        ))}
      </div>

      <div className="vrk-authotp-status" role="status" aria-live="polite">
        {status === 'verifying' && (
          <svg className="vrk-authotp-spinner" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        )}
        {status !== 'verifying' && <span className="vrk-authotp-status-dot" />}
        <span>{status === 'verifying' ? 'Verifying…' : message}</span>
      </div>

      <div className="vrk-authotp-resend">
        <button
          type="button"
          onClick={handleResend}
          disabled={resending || secondsLeft > 0}
          className="vrk-authotp-resend-btn"
        >
          {resending ? 'Sending…' : secondsLeft > 0 ? `Resend code (${secondsLeft}s)` : 'Resend code'}
        </button>
      </div>
    </div>
  );
}
