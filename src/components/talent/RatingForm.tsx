import { useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { fetchEngagementRatings, submitRating, type EngagementRatings } from '@/lib/talentNetwork';

interface Props {
  engagementId: string;
  /** Tag vocabulary for the side that is rating. */
  tags: Record<string, string>;
  /** Tag vocabulary of the other side, to render their rating once revealed. */
  theirTags: Record<string, string>;
  onDone?: () => void;
}

function Stars({ value }: { value: number }) {
  return (
    <span className="inline-flex" aria-label={`${value} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => <Star key={n} size={14} aria-hidden="true" className={n <= value ? 'fill-accent text-accent' : 'text-text-secondary'} />)}
    </span>
  );
}

export function RatingForm({ engagementId, tags, theirTags, onDone }: Props) {
  const [data, setData] = useState<EngagementRatings | null>(null);
  const [rating, setRating] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => fetchEngagementRatings(engagementId).then(setData).catch((e) => setError(e instanceof Error ? e.message : 'Could not load ratings.'));
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [engagementId]);

  const toggle = (t: string) => setPicked((p) => (p.includes(t) ? p.filter((x) => x !== t) : p.length < 5 ? [...p, t] : p));

  async function submit() {
    if (rating < 1) { setError('Choose a star rating.'); return; }
    setBusy(true);
    setError(null);
    try {
      await submitRating(engagementId, rating, picked, comment.trim());
      await load();
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not submit your rating.');
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <p className="text-sm text-text-secondary">{error ?? 'Loading…'}</p>;

  return (
    <div className="space-y-4">
      {data.mine ? (
        <div className="text-sm text-text-primary">
          <p className="mb-1 font-medium">Your rating</p>
          <Stars value={data.mine.rating} />
          {data.mine.comment && <p className="mt-1 text-text-secondary">{data.mine.comment}</p>}
        </div>
      ) : (
        <div className="space-y-3">
          <div role="radiogroup" aria-label="Star rating" className="flex gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} onClick={() => setRating(n)} className="p-1">
                <Star size={24} aria-hidden="true" className={n <= rating ? 'fill-accent text-accent' : 'text-text-secondary'} />
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(tags).map(([k, l]) => (
              <button key={k} type="button" aria-pressed={picked.includes(k)} onClick={() => toggle(k)}
                className={`rounded-full border px-3 py-1 text-xs ${picked.includes(k) ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}>{l}</button>
            ))}
          </div>
          <Textarea label="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={600} rows={3} />
          {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
          <Button onClick={() => void submit()} disabled={busy}>{busy ? 'Submitting…' : 'Submit rating'}</Button>
          <p className="text-xs text-text-secondary">Ratings stay hidden until both sides submit, or 14 days after the engagement ends.</p>
        </div>
      )}
      {data.mine && !data.theirs && <p className="text-xs text-text-secondary">Their rating becomes visible once they submit or after 14 days.</p>}
      {data.theirs && (
        <div className="text-sm text-text-primary">
          <p className="mb-1 font-medium">Their rating of you</p>
          <Stars value={data.theirs.rating} />
          <p className="mt-1 text-xs text-text-secondary">{data.theirs.tags.map((t) => theirTags[t] ?? t).join(' · ')}</p>
          {data.theirs.comment && <p className="mt-1 text-text-secondary">{data.theirs.comment}</p>}
        </div>
      )}
    </div>
  );
}
