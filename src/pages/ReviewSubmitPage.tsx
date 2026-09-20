import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, CheckCircle2, ExternalLink, Star } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { fetchReviewRequest, submitReview, type ReviewRequestPublic } from '@/lib/customerReview';

export function ReviewSubmitPage() {
  const { token } = useParams<{ token: string }>();
  const [req, setReq] = useState<ReviewRequestPublic | null | undefined>(undefined);
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ suggestPublic: boolean; googleUrl: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    (async () => setReq(await fetchReviewRequest(token)))();
  }, [token]);

  const handleSubmit = async () => {
    if (!token || rating === 0) return;
    setSubmitting(true);
    setError(null);
    const res = await submitReview(token, rating, feedback);
    setSubmitting(false);
    if (res.ok) {
      setResult({ suggestPublic: Boolean(res.suggest_public_review), googleUrl: res.google_review_url ?? null });
    } else {
      setError("Couldn't submit your review — please try again.");
    }
  };

  const alreadyDone = req && req.status !== 'sent';

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex-1 px-4 py-12">
        <div className="mx-auto w-full max-w-md">
          {req === undefined && (
            <p className="py-20 text-center text-sm text-text-secondary">Loading…</p>
          )}

          {req === null && (
            <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark">
              <AlertCircle size={28} className="mx-auto mb-3 text-text-secondary" />
              <h1 className="text-lg font-semibold text-text-primary">Link not valid</h1>
              <p className="mt-2 text-sm text-text-secondary">This review link isn't valid or has expired.</p>
            </div>
          )}

          {req && !result && alreadyDone && (
            <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark">
              <CheckCircle2 size={28} className="mx-auto mb-3 text-success" />
              <h1 className="text-lg font-semibold text-text-primary">Already submitted</h1>
              <p className="mt-2 text-sm text-text-secondary">Thanks — we already have your feedback on file.</p>
            </div>
          )}

          {req && !result && !alreadyDone && (
            <div className="rounded-2xl border border-border bg-bg-secondary p-6 text-center shadow-card dark:shadow-card-dark">
              <h1 className="text-lg font-semibold text-text-primary">
                How was your service with {req.business_name ?? 'us'}?
              </h1>
              <div className="mt-5 flex justify-center gap-1.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setRating(n)}
                    onMouseEnter={() => setHoverRating(n)}
                    onMouseLeave={() => setHoverRating(0)}
                    className="focus-ring rounded-lg p-1"
                    aria-label={`${n} star${n > 1 ? 's' : ''}`}
                  >
                    <Star
                      size={32}
                      className={(hoverRating || rating) >= n ? 'fill-warning-500 text-warning-500' : 'text-text-secondary'}
                    />
                  </button>
                ))}
              </div>

              {rating > 0 && (
                <div className="mt-5 text-left">
                  <textarea
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    rows={4}
                    placeholder="Anything you'd like to add? (optional)"
                    className="focus-ring w-full resize-none rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-secondary"
                  />
                </div>
              )}

              {error && <p className="mt-3 text-xs text-danger">{error}</p>}

              <button
                type="button"
                disabled={rating === 0 || submitting}
                onClick={handleSubmit}
                className="focus-ring mt-5 w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
              >
                {submitting ? 'Submitting…' : 'Submit'}
              </button>
            </div>
          )}

          {result && (
            <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark">
              <CheckCircle2 size={28} className="mx-auto mb-3 text-success" />
              <h1 className="text-lg font-semibold text-text-primary">Thanks for your feedback!</h1>
              {result.suggestPublic && result.googleUrl ? (
                <>
                  <p className="mt-2 text-sm text-text-secondary">
                    Would you mind sharing it publicly too? It really helps.
                  </p>
                  <a
                    href={result.googleUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="focus-ring mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent/90"
                  >
                    Leave a public review <ExternalLink size={14} />
                  </a>
                </>
              ) : (
                <p className="mt-2 text-sm text-text-secondary">
                  We've shared your feedback with the team so we can do better.
                </p>
              )}
            </div>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
