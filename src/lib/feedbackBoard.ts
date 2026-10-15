import type { RoadmapItem, RoadmapStatus, RoadmapCategory } from '@/lib/roadmap';

export type FeedbackStatusFilter = 'all' | Exclude<RoadmapStatus, 'declined'>;
export type FeedbackCategoryFilter = 'all' | RoadmapCategory;
export type FeedbackSort = 'top' | 'newest';

export interface FeedbackViewOptions {
  status: FeedbackStatusFilter;
  category: FeedbackCategoryFilter;
  sort: FeedbackSort;
  query: string;
  onlyMyVotes: boolean;
  votedIds: ReadonlySet<string>;
}

export const FEEDBACK_TITLE_MAX = 120;
export const FEEDBACK_TITLE_MIN = 4;
export const FEEDBACK_DESCRIPTION_MAX = 1000;

/** Filters + sorts ideas for the board. Pure, so it is unit-tested directly. */
export function selectFeedbackItems(items: readonly RoadmapItem[], opts: FeedbackViewOptions): RoadmapItem[] {
  const q = opts.query.trim().toLowerCase();
  const out = items.filter((i) => {
    if (opts.status !== 'all' && i.status !== opts.status) return false;
    if (opts.category !== 'all' && i.category !== opts.category) return false;
    if (opts.onlyMyVotes && !opts.votedIds.has(i.id)) return false;
    if (q && !`${i.title} ${i.description}`.toLowerCase().includes(q)) return false;
    return true;
  });
  return out.sort((a, b) => {
    if (opts.sort === 'newest') return Date.parse(b.created_at) - Date.parse(a.created_at);
    return b.votes_count - a.votes_count || Date.parse(b.created_at) - Date.parse(a.created_at);
  });
}

/** Per-status counts for the filter tabs (ignores the status filter itself). */
export function countByStatus(items: readonly RoadmapItem[]): Record<FeedbackStatusFilter, number> {
  const counts: Record<FeedbackStatusFilter, number> = {
    all: items.length,
    under_review: 0,
    planned: 0,
    in_progress: 0,
    shipped: 0,
  };
  for (const i of items) {
    if (i.status !== 'declined') counts[i.status] += 1;
  }
  return counts;
}

export interface IdeaDraft {
  title: string;
  description: string;
}

/** Returns field errors, or an empty object when the draft is valid. */
export function validateIdeaDraft(draft: IdeaDraft): Partial<Record<keyof IdeaDraft, string>> {
  const errors: Partial<Record<keyof IdeaDraft, string>> = {};
  const title = draft.title.trim();
  if (title.length < FEEDBACK_TITLE_MIN) errors.title = `Give your idea a short title (at least ${FEEDBACK_TITLE_MIN} characters).`;
  else if (title.length > FEEDBACK_TITLE_MAX) errors.title = `Keep the title under ${FEEDBACK_TITLE_MAX} characters.`;
  if (draft.description.trim().length > FEEDBACK_DESCRIPTION_MAX) {
    errors.description = `Keep the details under ${FEEDBACK_DESCRIPTION_MAX} characters.`;
  }
  return errors;
}

/** Postgres unique_violation — a double-click / second tab already recorded this vote. */
export function isDuplicateVoteError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
