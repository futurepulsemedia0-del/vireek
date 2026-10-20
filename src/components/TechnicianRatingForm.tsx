import { useState } from 'react';
import { Star } from 'lucide-react';
import {
  MAX_COMMENT_LENGTH,
  MAX_TAGS,
  TAG_LABELS,
  isNegativeTag,
  sanitizeTags,
  tagsForRating,
  type TechnicianRatingTag,
  type TechnicianRatingValue,
} from '@/lib/technicianRatings';

interface Props {
  technicianName: string;
  value: TechnicianRatingValue;
  onChange: (next: TechnicianRatingValue) => void;
  disabled?: boolean;
}

const RATING_LABELS = ['', 'Poor', 'Fair', 'Good', 'Very good', 'Excellent'];

export function TechnicianRatingForm({ technicianName, value, onChange, disabled = false }: Props) {
  const [hover, setHover] = useState(0);
  const shown = hover || value.rating;
  const offered = tagsForRating(value.rating);

  // Clicking the selected star again clears the rating (the section is optional).
  const setRating = (n: number) => {
    const next = value.rating === n ? 0 : n;
    onChange({ ...value, rating: next, tags: sanitizeTags(value.tags, next) });
  };

  const toggleTag = (tag: TechnicianRatingTag) => {
    const has = value.tags.includes(tag);
    if (!has && value.tags.length >= MAX_TAGS) return;
    onChange({ ...value, tags: has ? value.tags.filter((t) => t !== tag) : [...value.tags, tag] });
  };

  return (
    <section aria-label={`Rate ${technicianName}`} className="mt-6 border-t border-border pt-5 text-left">
      <h2 className="text-center text-sm font-semibold text-text-primary">
        How was {technicianName}? <span className="font-normal text-text-secondary">(optional)</span>
      </h2>

      <div role="radiogroup" aria-label={`Rating for ${technicianName}`} className="mt-3 flex justify-center gap-1.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value.rating === n}
            aria-label={`Rate ${technicianName} ${n} out of 5`}
            disabled={disabled}
            onClick={() => setRating(n)}
            onMouseEnter={() => setHover(n)}
            onMouseLeave={() => setHover(0)}
            className="focus-ring rounded-lg p-1 disabled:opacity-50"
          >
            <Star size={28} className={shown >= n ? 'fill-warning-500 text-warning-500' : 'text-text-secondary'} />
          </button>
        ))}
      </div>

      {value.rating > 0 && (
        <>
          <p className="mt-1 text-center text-xs text-text-secondary" aria-live="polite">
            {RATING_LABELS[value.rating]}
          </p>

          <div role="group" aria-label="What stood out?" className="mt-4 flex flex-wrap justify-center gap-2">
            {offered.map((tag) => {
              const on = value.tags.includes(tag);
              const tone = isNegativeTag(tag) ? 'border-danger/40 bg-danger/10 text-danger' : 'border-accent/40 bg-accent/10 text-accent';
              return (
                <button
                  key={tag}
                  type="button"
                  aria-pressed={on}
                  disabled={disabled || (!on && value.tags.length >= MAX_TAGS)}
                  onClick={() => toggleTag(tag)}
                  className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40 ${
                    on ? tone : 'border-border bg-bg-primary text-text-secondary hover:border-accent/40'
                  }`}
                >
                  {TAG_LABELS[tag]}
                </button>
              );
            })}
          </div>

          <textarea
            value={value.comment}
            onChange={(e) => onChange({ ...value, comment: e.target.value.slice(0, MAX_COMMENT_LENGTH) })}
            maxLength={MAX_COMMENT_LENGTH}
            rows={3}
            disabled={disabled}
            aria-label={`Comment about ${technicianName}`}
            placeholder={`Anything you'd like to tell us about ${technicianName}? (optional)`}
            className="focus-ring mt-4 w-full resize-none rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-secondary"
          />
          <p className="mt-1 text-right text-[11px] text-text-secondary/70">
            {value.comment.length}/{MAX_COMMENT_LENGTH}
          </p>
        </>
      )}
    </section>
  );
}
