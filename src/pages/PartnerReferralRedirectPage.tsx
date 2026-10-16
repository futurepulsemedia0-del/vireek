import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { storePartnerReferralCode } from '@/lib/partnerPortal';

/**
 * Public, unauthenticated landing for a partner's referral link
 * (https://vireek.com/r/{code}). Logs the click, remembers the code for
 * 30 days (see partnerPortal.ts), then sends the visitor on to the
 * homepage. SignupPage.tsx reads the stored code right after signUp() and
 * calls attribute_partner_referral() — see that file for the other half.
 */
export function PartnerReferralRedirectPage() {
  const { code } = useParams<{ code: string }>();

  useEffect(() => {
    if (!code) return;
    (async () => {
      // 1) A contractor's customer-referral link: count the click and send the friend to booking.
      try {
        const { data } = await supabase.rpc('track_referral_click', { p_code: code });
        if (data?.ok) {
          const ref = encodeURIComponent(code);
          window.location.replace(data.booking_slug ? `/book/${data.booking_slug}?ref=${ref}` : `/?ref=${ref}`);
          return;
        }
      } catch {
        // Not a customer-referral code (or the lookup failed): fall through to the partner program.
      }
      // 2) Vireek partner-program link (previous behaviour).
      storePartnerReferralCode(code);
      try {
        await supabase.rpc('record_partner_click', { p_code: code, p_landing_path: window.location.pathname });
      } finally {
        window.location.replace(`/?pref=${encodeURIComponent(code)}`);
      }
    })();
  }, [code]);

  return null;
}
