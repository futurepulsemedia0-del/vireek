import { useEffect } from 'react';
import { buildLocalBusinessJsonLd, fetchStructuredData, serializeJsonLd } from '@/lib/googleBooking';

const MARK = 'data-google-booking-jsonld';

/** Injects schema.org JSON-LD for a business's public booking page — only when the owner opted in. */
export function useGoogleStructuredData(slug: string | undefined): void {
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    let script: HTMLScriptElement | null = null;
    void (async () => {
      try {
        const data = await fetchStructuredData(slug);
        if (cancelled || !data) return;
        const ld = buildLocalBusinessJsonLd(data, `${window.location.origin}/book/${slug}`);
        if (!ld) return;
        document.head.querySelectorAll(`script[${MARK}]`).forEach((el) => el.remove());
        script = document.createElement('script');
        script.type = 'application/ld+json';
        script.setAttribute(MARK, slug);
        script.textContent = serializeJsonLd(ld);
        document.head.appendChild(script);
      } catch {
        /* structured data is an enhancement — never break the booking page */
      }
    })();
    return () => { cancelled = true; script?.remove(); };
  }, [slug]);
}
