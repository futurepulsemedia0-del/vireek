import { Star } from 'lucide-react';
import { SENTIMENT_CLASS, sentimentOf } from '@/lib/reputation';

export function Stars({ rating, size = 14 }: { rating: number; size?: number }) {
  return (
    <span className={`inline-flex items-center gap-0.5 ${SENTIMENT_CLASS[sentimentOf(rating)]}`} role="img" aria-label={`${rating} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} size={size} aria-hidden="true" className={i <= rating ? 'fill-current' : 'text-border'} />
      ))}
    </span>
  );
}
