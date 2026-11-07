// Cloudflare Turnstile bot challenge. The token goes to Supabase Auth as options.captchaToken; Auth verifies it
// server-side (Dashboard > Authentication > Attack Protection > CAPTCHA). Without VITE_TURNSTILE_SITE_KEY the
// widget renders nothing and reports a null token (local development).
import { useEffect, useRef } from 'react';
import { useAbuseT } from '@/i18n/abuseNamespace';
import { onCaptchaReset, setCaptchaToken } from '@/lib/captcha';

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id?: string): void;
  remove(id?: string): void;
}
declare global {
  interface Window { turnstile?: TurnstileApi }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SCRIPT_SRC; s.async = true; s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => { scriptPromise = null; reject(new Error('turnstile_script_failed')); };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

export const turnstileEnabled = Boolean(import.meta.env.VITE_TURNSTILE_SITE_KEY);

interface Props {
  /** Optional extra listener; the token is always published to src/lib/captcha.ts. */
  onToken?: (token: string | null) => void;
}

export function TurnstileWidget({ onToken }: Props) {
  const { t, language } = useAbuseT();
  const host = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | undefined>(undefined);

  useEffect(() => {
    const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
    const publish = (token: string | null) => { setCaptchaToken(token); onToken?.(token); };
    if (!siteKey || !host.current) { publish(null); return; }
    let cancelled = false;
    loadScript().then(() => {
      if (cancelled || !host.current || !window.turnstile) return;
      widgetId.current = window.turnstile.render(host.current, {
        sitekey: siteKey, theme: 'auto', language: language.slice(0, 2), appearance: 'interaction-only',
        callback: (token: string) => publish(token),
        'expired-callback': () => publish(null),
        'error-callback': () => publish(null),
      });
    }).catch(() => publish(null));
    const offReset = onCaptchaReset(() => { if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current); });
    return () => { cancelled = true; offReset(); setCaptchaToken(null); if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  if (!turnstileEnabled) return null;
  return <div ref={host} role="group" aria-label={t('auth.captchaLabel')} className="min-h-[1px]" />;
}
