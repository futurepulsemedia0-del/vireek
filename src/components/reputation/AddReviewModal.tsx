import { useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import { PLATFORMS, PLATFORM_LABEL, addManualReview, safeReviewUrl, type Overview, type Platform } from '@/lib/reputation';
import { Stars } from '@/components/reputation/Stars';

const today = () => new Date().toISOString().slice(0, 10);

export function AddReviewModal({ onClose, onAdded }: { onClose: () => void; onAdded: (o: Overview) => void }) {
  const { toast } = useToast();
  const dialogRef = useFocusTrap(true);
  useEscapeToClose(true, onClose);
  const [platform, setPlatform] = useState<Platform>('google');
  const [rating, setRating] = useState(5);
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [date, setDate] = useState(today());
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  const urlError = url.trim() && !safeReviewUrl(url) ? 'Use an https link from Google, Yelp or Facebook.' : undefined;
  const dateError = date > today() ? "The review date can't be in the future." : undefined;

  const submit = async () => {
    setTouched(true);
    if (urlError || dateError) return;
    setBusy(true);
    try {
      onAdded(
        await addManualReview({
          platform,
          rating,
          reviewerName: name,
          body,
          reviewedAt: new Date(`${date}T12:00:00`).toISOString(),
          reviewUrl: url.trim() || undefined,
        }),
      );
      toast('Review added to your inbox.', 'success');
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not add the review.', 'error');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-review-title"
        className="relative max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 shadow-card-hover sm:rounded-2xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="add-review-title" className="text-lg font-bold text-text-primary">Log a review</h2>
            <p className="mt-1 text-sm text-text-secondary">Add a review you saw on a platform that isn't synced yet. It's labelled “manual” in your inbox.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring rounded-lg p-1.5 text-text-secondary hover:text-text-primary">
            <X size={18} />
          </button>
        </div>

        <div className="mt-5 space-y-4">
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-text-primary">Platform</legend>
            <div className="flex flex-wrap gap-2">
              {PLATFORMS.map((p) => (
                <label key={p} className={`focus-within:ring-2 cursor-pointer rounded-full border px-3.5 py-1.5 text-sm font-medium ${platform === p ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}>
                  <input type="radio" name="platform" className="sr-only" checked={platform === p} onChange={() => setPlatform(p)} />
                  {PLATFORM_LABEL[p]}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-text-primary">Rating</legend>
            <div className="flex items-center gap-1" role="radiogroup" aria-label="Rating">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={rating === n}
                  aria-label={`${n} star${n === 1 ? '' : 's'}`}
                  onClick={() => setRating(n)}
                  className={`focus-ring flex h-11 w-11 items-center justify-center rounded-xl border text-sm font-semibold ${rating === n ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}
                >
                  {n}
                </button>
              ))}
              <span className="ml-2"><Stars rating={rating} size={16} /></span>
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Reviewer name" value={name} maxLength={120} placeholder="Anonymous" onChange={(e) => setName(e.target.value)} />
            <Input label="Review date" type="date" value={date} max={today()} error={touched ? dateError : undefined} onChange={(e) => setDate(e.target.value)} />
          </div>
          <Textarea label="Review text" rows={4} value={body} maxLength={5000} placeholder="Paste what the customer wrote (optional)" onChange={(e) => setBody(e.target.value)} />
          <Input label="Link to the review" type="url" inputMode="url" value={url} placeholder="https://…" error={touched ? urlError : undefined} helperText="Optional — lets you jump straight to it." onChange={(e) => setUrl(e.target.value)} />
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="button" size="sm" onClick={submit} disabled={busy}>
            {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />} Add review
          </Button>
        </div>
      </div>
    </div>
  );
}
