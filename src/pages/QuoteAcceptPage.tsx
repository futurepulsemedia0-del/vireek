import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { FileText, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { fetchQuoteForToken, respondToQuote, calculateQuoteTotals, formatCents, PublicQuoteInfo } from '@/lib/quotes';

export function QuoteAcceptPage() {
  const { token } = useParams<{ token: string }>();
  const [quote, setQuote] = useState<PublicQuoteInfo | null | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [responded, setResponded] = useState<'accepted' | 'declined' | null>(null);

  useEffect(() => {
    if (!token) return;
    fetchQuoteForToken(token).then(setQuote);
  }, [token]);

  const handleRespond = async (response: 'accepted' | 'declined') => {
    if (!token) return;
    setSubmitting(true);
    const ok = await respondToQuote(token, response);
    if (ok) setResponded(response);
    setSubmitting(false);
  };

  const totals = quote ? calculateQuoteTotals(quote.line_items, quote.tax_percent) : null;

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex flex-1 items-center justify-center px-4 py-16">
        <div className="w-full max-w-md rounded-2xl border border-border bg-bg-secondary p-8 shadow-card dark:shadow-card-dark">
          {quote === undefined && <p className="text-center text-sm text-text-secondary">Loading your quote…</p>}

          {quote === null && (
            <div className="text-center">
              <AlertCircle size={28} className="mx-auto mb-3 text-text-secondary" />
              <h1 className="text-lg font-semibold text-text-primary">Quote not found</h1>
              <p className="mt-2 text-sm text-text-secondary">This link doesn't match an active quote.</p>
            </div>
          )}

          {quote && !responded && quote.status === 'sent' && (
            <>
              <div className="mb-4 flex items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  <FileText size={20} />
                </span>
                <div>
                  <h1 className="text-lg font-semibold text-text-primary">Your quote from {quote.business_name ?? 'us'}</h1>
                  <p className="text-xs text-text-secondary">Prepared for {quote.customer_name}</p>
                </div>
              </div>

              <div className="mb-4 divide-y divide-border/60 rounded-xl border border-border">
                {quote.line_items.map((li, i) => (
                  <div key={i} className="flex items-center justify-between px-4 py-2.5 text-sm">
                    <span className="text-text-primary">
                      {li.description} {li.quantity > 1 && <span className="text-text-secondary">× {li.quantity}</span>}
                    </span>
                    <span className="text-text-secondary">{formatCents(li.quantity * li.unit_price_cents)}</span>
                  </div>
                ))}
              </div>

              {totals && (
                <div className="mb-4 flex items-center justify-between rounded-xl bg-bg-tertiary px-4 py-3">
                  <span className="text-sm font-medium text-text-primary">Total</span>
                  <span className="text-lg font-bold text-text-primary">{formatCents(totals.totalCents)}</span>
                </div>
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => handleRespond('declined')}
                  className="focus-ring flex-1 rounded-xl border border-border py-2.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
                >
                  Decline
                </button>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => handleRespond('accepted')}
                  className="focus-ring flex-1 rounded-xl bg-accent py-2.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
                >
                  Accept quote
                </button>
              </div>
            </>
          )}

          {quote && quote.status !== 'sent' && !responded && (
            <div className="text-center">
              <AlertCircle size={28} className="mx-auto mb-3 text-text-secondary" />
              <h1 className="text-lg font-semibold text-text-primary">This quote isn't awaiting a response</h1>
              <p className="mt-2 text-sm text-text-secondary">It's already marked as {quote.status}.</p>
            </div>
          )}

          {responded === 'accepted' && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="text-center">
              <CheckCircle2 size={28} className="mx-auto mb-3 text-success-500" />
              <h1 className="text-lg font-semibold text-text-primary">Quote accepted</h1>
              <p className="mt-2 text-sm text-text-secondary">We'll be in touch to schedule the work.</p>
            </motion.div>
          )}

          {responded === 'declined' && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="text-center">
              <XCircle size={28} className="mx-auto mb-3 text-text-secondary" />
              <h1 className="text-lg font-semibold text-text-primary">Quote declined</h1>
              <p className="mt-2 text-sm text-text-secondary">Thanks for letting us know.</p>
            </motion.div>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
