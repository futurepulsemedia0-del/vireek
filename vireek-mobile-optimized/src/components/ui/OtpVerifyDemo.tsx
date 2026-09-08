import { useEffect, useRef } from 'react';
import './otp-verify-demo.css';
import { initOtpVerifyDemo } from './otp-verify-demo';

interface OtpVerifyDemoProps {
  eyebrow?: string;
  title?: string;
  subtitle?: string;
  /** number of digit boxes, default 6 */
  length?: number;
  className?: string;
}

/**
 * Interactive "how Vireek's 2FA feels" showcase for marketing pages
 * (e.g. SecurityPage, or a LiveDemo-style section). Plays an idle
 * self-demo when nobody is interacting, and lets real visitors type
 * the demo code themselves.
 *
 * This is presentational only — it is not connected to real
 * authentication. Actual 2FA lives in SecuritySettingsPage.tsx via
 * supabase.auth.mfa.
 */
export function OtpVerifyDemo({
  eyebrow = 'Live security demo',
  title = 'Two-factor verification',
  subtitle = 'This is exactly how every Vireek account is protected — try it yourself.',
  length = 6,
  className = '',
}: OtpVerifyDemoProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!rootRef.current) return;
    const destroy = initOtpVerifyDemo(rootRef.current);
    return destroy;
  }, []);

  const mid = Math.floor(length / 2);

  return (
    <div className={`vrk-otp ${className}`} ref={rootRef} dir="ltr">
      <div className="vrk-otp-head">
        <span className="vrk-otp-eyebrow">{eyebrow}</span>
        <h3 className="vrk-otp-title">{title}</h3>
        <p className="vrk-otp-sub">{subtitle}</p>
      </div>

      <form className="vrk-otp-form" autoComplete="off" noValidate>
        <div className="vrk-otp-boxes">
          <div className="vrk-otp-ripple" aria-hidden="true" />
          <div className="vrk-otp-ripple vrk-otp-ripple--accent" aria-hidden="true" />

          {Array.from({ length }).map((_, i) => (
            <div className="vrk-otp-box-wrap" key={i}>
              {i === mid && <span className="vrk-otp-divider" aria-hidden="true" />}
              <div className="vrk-otp-box">
                <span className="vrk-otp-caret" aria-hidden="true" />
                <input
                  className="vrk-otp-input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={1}
                  aria-label={`Digit ${i + 1} of ${length}`}
                />
                <svg className="vrk-otp-check" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 12.5l4.5 4.5L19 7" />
                </svg>
              </div>
            </div>
          ))}
        </div>

        <div className="vrk-otp-status">
          <span className="vrk-otp-status-dot" />
          <span className="vrk-otp-status-text">Enter the {length}-digit code</span>
        </div>
      </form>
    </div>
  );
}
