import { useMemo, useState } from 'react';
import { MessageSquare, Star } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { buildCommentFeed, type FeedbackRecord, type NpsClass, type Sentiment } from '@/lib/feedbackAnalytics';

const PAGE = 20;
const SENTIMENT_TONE: Record<Sentiment, string> = {
  positive: 'bg-success/10 text-success',
  neutral: 'bg-bg-tertiary text-text-secondary',
  negative: 'bg-danger/10 text-danger',
};
const CLASS_TONE: Record<NpsClass, string> = {
  promoter: 'text-success', passive: 'text-amber-600', detractor: 'text-danger',
};

interface Props {
  records: FeedbackRecord[];
  onOpen: (record: FeedbackRecord) => void;
}

export function FeedbackCommentFeed({ records, onOpen }: Props) {
  const [sentiment, setSentiment] = useState<Sentiment | 'all'>('all');
  const [npsClass, setNpsClass] = useState<NpsClass | 'all'>('all');
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);

  const commentCount = useMemo(() => records.filter((r) => r.comment).length, [records]);
  const feed = useMemo(() => buildCommentFeed(records, { sentiment, npsClass, search }, 500), [records, sentiment, npsClass, search]);

  const reset = () => { setSentiment('all'); setNpsClass('all'); setSearch(''); setShown(PAGE); };
  const filtersActive = sentiment !== 'all' || npsClass !== 'all' || search.trim() !== '';

  return (
    <section aria-label="Customer comments" className="rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-base font-semibold text-text-primary"><MessageSquare size={18} className="text-accent" /> What customers are saying</h3>
        <p className="text-xs text-text-secondary">{commentCount.toLocaleString()} comment{commentCount === 1 ? '' : 's'} · sentiment is estimated from the words and the star rating</p>
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <input
          type="search" value={search} onChange={(e) => { setSearch(e.target.value); setShown(PAGE); }}
          placeholder="Search comments, customers, technicians" aria-label="Search comments"
          className="focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary"
        />
        <select aria-label="Filter by sentiment" value={sentiment} onChange={(e) => { setSentiment(e.target.value as Sentiment | 'all'); setShown(PAGE); }} className="focus-ring rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary">
          <option value="all">Any sentiment</option><option value="negative">Negative</option><option value="neutral">Neutral</option><option value="positive">Positive</option>
        </select>
        <select aria-label="Filter by NPS group" value={npsClass} onChange={(e) => { setNpsClass(e.target.value as NpsClass | 'all'); setShown(PAGE); }} className="focus-ring rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary">
          <option value="all">All customers</option><option value="detractor">Detractors</option><option value="passive">Passives</option><option value="promoter">Promoters</option>
        </select>
      </div>

      {commentCount === 0 ? (
        <EmptyState icon={MessageSquare} title="No written comments in this period" description="Ratings are counted above; comments appear here as customers leave them on the post-job survey or after a call." />
      ) : feed.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <p className="text-sm text-text-secondary">No comments match these filters.</p>
          {filtersActive && <Button className="mt-3" size="sm" variant="secondary" onClick={reset}>Clear filters</Button>}
        </div>
      ) : (
        <>
          <ul className="space-y-3">
            {feed.slice(0, shown).map(({ record: r, npsClass: cls, sentiment: s }) => (
              <li key={`${r.source}-${r.feedback_id}`} className="rounded-xl border border-border p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="flex items-center gap-0.5" aria-label={`${r.rating} out of 5 stars`}>
                    {[1, 2, 3, 4, 5].map((n) => <Star key={n} size={13} className={n <= r.rating ? 'fill-amber-400 text-amber-400' : 'text-border'} />)}
                  </span>
                  <span className={`font-semibold capitalize ${CLASS_TONE[cls]}`}>{cls}</span>
                  <span className={`rounded-md px-2 py-0.5 font-semibold capitalize ${SENTIMENT_TONE[s.label]}`} title={s.signals.length ? `Signals: ${s.signals.join(', ')}` : 'Based on the star rating'}>{s.label}</span>
                  <span className="text-text-secondary">{r.source === 'review' ? 'Job survey' : 'Call rating'} · {new Date(r.responded_at).toLocaleDateString(undefined, { dateStyle: 'medium' })}</span>
                </div>
                <blockquote className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-text-primary">“{r.comment}”</blockquote>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 truncate text-xs text-text-secondary">{[r.customer_name, r.service_type, r.technician_name].filter(Boolean).join(' · ') || 'No job details'}</p>
                  <Button size="sm" variant="secondary" onClick={() => onOpen(r)}>{r.job_id ? 'View job' : 'View details'}</Button>
                </div>
              </li>
            ))}
          </ul>
          {feed.length > shown && <div className="mt-4 text-center"><Button size="sm" variant="secondary" onClick={() => setShown((n) => n + PAGE)}>Show more ({(feed.length - shown).toLocaleString()} left)</Button></div>}
        </>
      )}
      <span className="sr-only" aria-live="polite">{feed.length} comments shown</span>
    </section>
  );
}
