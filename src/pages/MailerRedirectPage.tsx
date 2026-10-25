import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Loader2, MailX } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { getVisitorId } from '@/lib/landingPages';
import { isValidTrackingCode, landingRedirectPath, normalizeTrackingCode } from '@/lib/directMail';

type State = { kind: 'loading' } | { kind: 'invalid' } | { kind: 'unavailable'; business: string | null } | { kind: 'error' };

/**
 * Public QR / short-link target:  /m/:code
 * Records one scan, then forwards to the campaign's landing page carrying the attribution the existing landing
 * analytics already understand (utm_source=direct_mail, utm_medium=postcard, utm_campaign, utm_content=code).
 */
export function MailerRedirectPage() {
  const { code = '' } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!isValidTrackingCode(code)) { setState({ kind: 'invalid' }); return; }
    setState({ kind: 'loading' });
    (async () => {
      try {
        const { data, error } = await supabase.rpc('direct_mail_resolve_scan', { p_code: normalizeTrackingCode(code), p_visitor_id: getVisitorId() });
        if (cancelled) return;
        if (error) { setState({ kind: 'error' }); return; }
        const res = data as { landing_slug: string | null; campaign_id: string; business_name: string | null; code: string } | null;
        if (!res) { setState({ kind: 'invalid' }); return; }
        if (!res.landing_slug) { setState({ kind: 'unavailable', business: res.business_name }); return; }
        navigate(landingRedirectPath(res.landing_slug, res.campaign_id, res.code), { replace: true });
      } catch {
        if (!cancelled) setState({ kind: 'error' });
      }
    })();
    return () => { cancelled = true; };
  }, [code, navigate, attempt]);

  if (state.kind === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-bg-primary p-6" aria-busy="true">
        <p role="status" className="flex items-center gap-2 text-sm text-text-secondary"><Loader2 className="animate-spin" size={18} /> Opening your offer…</p>
      </main>
    );
  }

  const copy = {
    invalid: { title: 'We couldn’t find that offer', body: 'Check the code printed on your postcard, or contact the business directly.' },
    unavailable: { title: 'This offer page isn’t available right now', body: state.kind === 'unavailable' && state.business ? `Please contact ${state.business} directly.` : 'Please contact the business directly.' },
    error: { title: 'Something went wrong', body: 'Please check your connection and try again.' },
  }[state.kind];

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-primary p-6">
      <div className="max-w-sm text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><MailX size={26} /></span>
        <h1 className="mt-4 text-lg font-semibold text-text-primary">{copy.title}</h1>
        <p className="mt-1.5 text-sm text-text-secondary">{copy.body}</p>
        {state.kind === 'error' && (
          <button type="button" onClick={() => setAttempt((a) => a + 1)} className="focus-ring mt-5 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary">Try again</button>
        )}
      </div>
    </main>
  );
}

export default MailerRedirectPage;
