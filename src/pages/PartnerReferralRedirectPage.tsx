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
    storePartnerReferralCode(code);
    supabase.rpc('record_partner_click', { p_code: code, p_landing_path: window.location.pathname }).finally(() => {
      window.location.replace(`/?pref=${encodeURIComponent(code)}`);
    });
  }, [code]);

  return null;
}
