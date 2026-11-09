import { useEffect, useId, useState } from 'react';
import { ExternalLink, Landmark, Loader2 } from 'lucide-react';
import {
  fetchPublicQuoteFinancing, openPartnerApplication, type PublicQuoteFinancing,
} from '@/lib/financingPartnersApi';
import {
  FINANCING_STATUS_VIEW, PARTNER_IS_LENDER_NOTICE, customerPanelState, effectiveOfferStatus, formatMoney,
} from '@/lib/financingPartners';

export function QuoteFinancingOptions({ quoteToken }: { quoteToken: string }) {
  const [data, setData] = useState<PublicQuoteFinancing | null>(null);
  const [loading, setLoading] = useState(true);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ackId = useId();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchPublicQuoteFinancing(quoteToken).then((d) => { if (alive) setData(d); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [quoteToken]);

  if (loading || !data?.available || !data.status || !data.partner_name) return null;

  const status = effectiveOfferStatus(data.status, data.expires_at ?? new Date(0).toISOString());
  const panel = customerPanelState({ available: true, status });
  if (panel.kind === 'hidden') return null;

  async function apply() {
    if (!data?.offer_token || !data.disclosure_version) return;
    setBusy(true);
    setError(null);
    try {
      const url = await openPartnerApplication({ offerToken: data.offer_token, disclosureVersion: data.disclosure_version });
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const amount = data.amount_cents ? formatMoney(data.amount_cents, data.currency ?? 'USD') : null;

  return (
    <section aria-labelledby="quote-financing-title" className="mt-4 rounded-2xl border border-accent/25 bg-accent/5 p-4 text-sm">
      <h2 id="quote-financing-title" className="flex items-center gap-2 font-semibold text-text-primary">
        <Landmark className="h-4 w-4 text-accent" aria-hidden="true" /> Pay over time with {data.partner_name}
      </h2>
      <p className="mt-1 text-xs text-text-secondary">{PARTNER_IS_LENDER_NOTICE(data.partner_name)}</p>
      {amount && <p className="mt-2 text-text-secondary">Quote total {amount}. Financing is optional.</p>}

      {panel.kind === 'open' && (
        <>
          <p className="mt-3 text-xs leading-relaxed text-text-secondary">{data.disclosure_body}</p>
          <div className="mt-3 flex items-start gap-2">
            <input id={ackId} type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 h-4 w-4" />
            <label htmlFor={ackId} className="text-xs text-text-primary">I’ve read this. I understand {data.partner_name} is the lender, not Vireek.</label>
          </div>
          <button
            type="button" onClick={apply} disabled={!ack || busy}
            className="mt-3 inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ExternalLink className="h-4 w-4" aria-hidden="true" />}
            {busy ? 'Opening…' : `Check my options with ${data.partner_name}`}
          </button>
          {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
        </>
      )}

      {panel.kind === 'in_progress' && (
        <p className="mt-3 text-xs text-text-secondary" role="status">{FINANCING_STATUS_VIEW[panel.status].label}. Any questions about your application go to {data.partner_name}.</p>
      )}
      {panel.kind === 'closed' && (
        <p className="mt-3 text-xs text-text-secondary" role="status">
          {panel.status === 'declined' ? `${data.partner_name} wasn’t able to offer financing. You can still pay your contractor directly.` : FINANCING_STATUS_VIEW[panel.status].label + '.'}
        </p>
      )}
    </section>
  );
}
