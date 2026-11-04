/**
 * Public Win Card — /win/:token (no auth).
 * Reads ONLY through the win-card-public edge function. The image is the server-rendered card, so the page
 * can show nothing the owner did not approve. Crawlers get OG tags from api/win-card.ts instead.
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { FileX } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Skeleton } from '@/components/Skeleton';
import { EmptyState } from '@/components/EmptyState';
import { ctaPublicWinCard, fetchPublicWinCard, reportPublicWinCard, type PublicCardPayload } from '@/lib/winCardsApi';

type State = { kind: 'loading' } | { kind: 'ready'; data: PublicCardPayload } | { kind: 'missing' } | { kind: 'error' };
const REASONS: { value: string; label: string }[] = [
  { value: 'contains_personal_info', label: 'Shows personal information' },
  { value: 'inaccurate', label: 'Looks inaccurate' },
  { value: 'spam_or_abuse', label: 'Spam or abuse' },
  { value: 'other', label: 'Something else' },
];

export function WinCardPublicPage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [reporting, setReporting] = useState(false);
  const [reported, setReported] = useState(false);
  const [reason, setReason] = useState(REASONS[0].value);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    (async () => {
      if (!token) return setState({ kind: 'missing' });
      const r = await fetchPublicWinCard(token);
      if (cancelled) return;
      setState(r.ok ? { kind: 'ready', data: r.data } : { kind: r.reason === 'not_found' ? 'missing' : 'error' });
    })();
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => { document.head.removeChild(meta); };
  }, []);

  const goCta = async () => {
    if (!token) return;
    setBusy(true);
    const r = await ctaPublicWinCard(token);
    setBusy(false);
    if (r.ok) window.location.assign(r.data.url);
  };
  const submitReport = async () => {
    if (!token) return;
    setBusy(true);
    await reportPublicWinCard(token, reason);
    setBusy(false);
    setReported(true);
    setReporting(false);
  };

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:py-12">
        {state.kind === 'loading' && (
          <div className="space-y-4" aria-busy="true" aria-label="Loading card">
            <Skeleton className="aspect-square w-full rounded-2xl" />
            <Skeleton className="h-6 w-2/3" />
          </div>
        )}
        {state.kind === 'missing' && (
          <EmptyState icon={FileX} title="This card is no longer available" description="The owner may have taken it down, or its link has expired." />
        )}
        {state.kind === 'error' && (
          <EmptyState icon={FileX} title="Couldn't load this card" description="Please check your connection and refresh the page." action={{ label: 'Try again', onClick: () => window.location.reload() }} />
        )}
        {state.kind === 'ready' && token && (
          <article className="space-y-5">
            {/* The SVG's own <title>/<desc> carry the alt text; the text below is the same approved content for screen readers. */}
            <img
              src={`/api/win-card?t=${encodeURIComponent(token)}&img=square&fmt=svg&anim=1`}
              alt={[state.data.card.publicFields.headline, state.data.card.publicFields.detail, state.data.card.publicFields.valueText].filter(Boolean).join(' ')}
              width={1080}
              height={1080}
              className="w-full rounded-2xl border border-border"
            />
            {state.data.card.publicFields.caption && <p className="text-base leading-relaxed text-text-primary">{state.data.card.publicFields.caption}</p>}
            {state.data.card.publicFields.disclaimer && <p className="text-xs text-text-secondary">{state.data.card.publicFields.disclaimer}</p>}

            <div className="flex flex-wrap items-center gap-3">
              {state.data.cta && (
                <button type="button" onClick={goCta} disabled={busy} className="focus-ring rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60">
                  See how it works
                </button>
              )}
              {!reported && !reporting && (
                <button type="button" onClick={() => setReporting(true)} className="focus-ring rounded-xl px-3 py-2 text-sm text-text-secondary underline-offset-4 hover:text-text-primary hover:underline">
                  Report this card
                </button>
              )}
              {reported && <p role="status" className="text-sm text-text-secondary">Thanks. Your report was received.</p>}
            </div>

            {reporting && (
              <fieldset className="rounded-2xl border border-border bg-bg-secondary p-4">
                <legend className="px-1 text-sm font-medium text-text-primary">What is wrong with this card?</legend>
                <div className="mt-2 space-y-2">
                  {REASONS.map((r) => (
                    <label key={r.value} className="flex items-center gap-2 text-sm text-text-secondary">
                      <input type="radio" name="reason" value={r.value} checked={reason === r.value} onChange={() => setReason(r.value)} /> {r.label}
                    </label>
                  ))}
                </div>
                <div className="mt-3 flex gap-2">
                  <button type="button" onClick={submitReport} disabled={busy} className="focus-ring rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">Send report</button>
                  <button type="button" onClick={() => setReporting(false)} className="focus-ring rounded-xl border border-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary">Cancel</button>
                </div>
              </fieldset>
            )}
          </article>
        )}
      </main>
      <Footer />
    </div>
  );
}
