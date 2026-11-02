import { useEffect, useRef } from 'react';

declare global { interface Window { turnstile?: { render: (el: HTMLElement, o: Record<string, unknown>) => string; remove: (id: string) => void; reset: (id: string) => void } } }

const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<void> | null = null;
function load(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  loading ??= new Promise<void>((res, rej) => {
    const s = document.createElement('script'); s.src = SRC; s.async = true; s.onload = () => res(); s.onerror = () => rej(new Error('turnstile'));
    document.head.appendChild(s);
  });
  return loading;
}

/** Cloudflare Turnstile. A site key starting with "mock-" (e2e only) skips the vendor script and emits a fixed test token;
 *  the server still verifies every token, so this grants nothing in production. */
export function TurnstileWidget({ siteKey, onToken }: { siteKey: string; onToken: (t: string | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (siteKey.startsWith('mock-')) { onToken('human-ok-token'); return; }
    let id: string | null = null; let dead = false;
    load().then(() => {
      if (dead || !ref.current || !window.turnstile) return;
      id = window.turnstile.render(ref.current, { sitekey: siteKey, callback: (t: string) => onToken(t), 'expired-callback': () => onToken(null), 'error-callback': () => onToken(null) });
    }).catch(() => onToken(null));
    return () => { dead = true; if (id && window.turnstile) window.turnstile.remove(id); };
  }, [siteKey, onToken]);
  if (siteKey.startsWith('mock-')) return null;
  return <div ref={ref} aria-label="Human verification" />;
}
