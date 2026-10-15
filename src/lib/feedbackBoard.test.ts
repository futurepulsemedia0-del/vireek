import { describe, it, expect } from 'vitest';
import type { RoadmapItem } from '@/lib/roadmap';
import { countByStatus, isDuplicateVoteError, selectFeedbackItems, validateIdeaDraft } from './feedbackBoard';

const mk = (o: Partial<RoadmapItem> & { id: string }): RoadmapItem => ({
  title: 'Idea',
  description: '',
  category: 'feature',
  status: 'under_review',
  votes_count: 0,
  submitted_by: null,
  admin_note: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...o,
});

const base = { status: 'all', category: 'all', sort: 'top', query: '', onlyMyVotes: false, votedIds: new Set<string>() } as const;

const items = [
  mk({ id: 'a', title: 'Google Calendar sync', votes_count: 3, status: 'planned', category: 'integration' }),
  mk({ id: 'b', title: 'Dark mode', votes_count: 9, created_at: '2026-03-01T00:00:00Z' }),
  mk({ id: 'c', title: 'Faster dispatch', description: 'calendar view', votes_count: 9, created_at: '2026-04-01T00:00:00Z', status: 'shipped' }),
];

describe('selectFeedbackItems', () => {
  it('sorts by votes, tie-broken by newest', () => {
    expect(selectFeedbackItems(items, base).map((i) => i.id)).toEqual(['c', 'b', 'a']);
  });
  it('sorts by newest', () => {
    expect(selectFeedbackItems(items, { ...base, sort: 'newest' }).map((i) => i.id)).toEqual(['c', 'b', 'a']);
  });
  it('filters by status, category and search across title + description', () => {
    expect(selectFeedbackItems(items, { ...base, status: 'planned' }).map((i) => i.id)).toEqual(['a']);
    expect(selectFeedbackItems(items, { ...base, category: 'integration' }).map((i) => i.id)).toEqual(['a']);
    expect(selectFeedbackItems(items, { ...base, query: ' CALENDAR ' }).map((i) => i.id).sort()).toEqual(['a', 'c']);
  });
  it('filters to my votes and does not mutate the input', () => {
    const copy = [...items];
    expect(selectFeedbackItems(items, { ...base, onlyMyVotes: true, votedIds: new Set(['b']) }).map((i) => i.id)).toEqual(['b']);
    expect(items).toEqual(copy);
  });
});

describe('countByStatus', () => {
  it('counts per status and ignores declined in the total tabs', () => {
    const c = countByStatus([...items, mk({ id: 'd', status: 'declined' })]);
    expect(c).toMatchObject({ all: 4, under_review: 1, planned: 1, shipped: 1, in_progress: 0 });
  });
});

describe('validateIdeaDraft / isDuplicateVoteError', () => {
  it('requires a real title and caps lengths', () => {
    expect(validateIdeaDraft({ title: '  ab ', description: '' }).title).toBeTruthy();
    expect(validateIdeaDraft({ title: 'Good title', description: '' })).toEqual({});
    expect(validateIdeaDraft({ title: 'x'.repeat(121), description: '' }).title).toBeTruthy();
    expect(validateIdeaDraft({ title: 'Good title', description: 'y'.repeat(1001) }).description).toBeTruthy();
  });
  it('detects unique_violation only', () => {
    expect(isDuplicateVoteError({ code: '23505' })).toBe(true);
    expect(isDuplicateVoteError({ code: '42501' })).toBe(false);
    expect(isDuplicateVoteError(null)).toBe(false);
  });
});
