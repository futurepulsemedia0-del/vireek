import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';

export function ReferralRedirectPage() {
  const { code } = useParams<{ code: string }>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!code) return;
    (async () => {
      const { data, error } = await supabase.rpc('track_referral_click', { p_code: code });
      if (error || !data?.ok) {
        setFailed(true);
        return;
      }
      const dest = data.booking_slug ? `/book/${data.booking_slug}?ref=${code}` : `/?ref=${code}`;
      window.location.replace(dest);
    })();
  }, [code]);

  if (!failed) return null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary px-4 text-center">
      <p className="text-sm text-text-secondary">This referral link isn't valid.</p>
    </div>
  );
}
