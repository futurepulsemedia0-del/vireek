import { describe, expect, it } from 'vitest';
import {
  applyMention,
  buildThreads,
  commentEntityPath,
  describeCommentError,
  detectMentionQuery,
  draftFromBody,
  extractMentionIds,
  filterCandidates,
  filterThreads,
  mentionToken,
  parseBody,
  plainText,
  relativeTime,
  removeComment,
  sanitizeMentionName,
  serializeDraft,
  upsertComment,
  validateDraft,
  COMMENT_MAX_LENGTH,
  type CommentRow,
  type MentionCandidate,
} from '@/lib/comments';

const ANA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';

function row(over: Partial<CommentRow> = {}): CommentRow {
  return {
    id: 'c1',
    user_id: 'owner',
    entity_type: 'job',
    entity_id: JOB,
    parent_id: null,
    author_id: ANA,
    author_name: 'Ana',
    body: 'hello',
    mentions: [],
    resolved_at: null,
    resolved_by: null,
    resolved_by_name: null,
    edited_at: null,
    deleted_at: null,
    created_at: '2026-10-01T10:00:00.000Z',
    updated_at: '2026-10-01T10:00:00.000Z',
    ...over,
  };
}

const people: MentionCandidate[] = [
  { userId: ANA, name: 'Ana Lee', role: 'owner' },
  { userId: BOB, name: 'Bob Stone', role: 'technician' },
  { userId: 'c', name: 'Annabel Ray', role: 'member' },
];

describe('tokens', () => {
  it('sanitizes names that would break the token', () => {
    expect(sanitizeMentionName('A [b] (c)\nd')).toBe('A b c d');
    expect(sanitizeMentionName('   ')).toBe('Teammate');
  });

  it('parses text and mentions in order, lower-casing ids', () => {
    const body = `Hi ${mentionToken({ userId: ANA.toUpperCase(), name: 'Ana Lee' })}, see ${mentionToken({ userId: BOB, name: 'Bob' })}!`;
    expect(parseBody(body)).toEqual([
      { type: 'text', text: 'Hi ' },
      { type: 'mention', userId: ANA, name: 'Ana Lee' },
      { type: 'text', text: ', see ' },
      { type: 'mention', userId: BOB, name: 'Bob' },
      { type: 'text', text: '!' },
    ]);
    expect(plainText(body)).toBe('Hi @Ana Lee, see @Bob!');
    expect(extractMentionIds(`${body} ${mentionToken({ userId: ANA, name: 'Ana' })}`)).toEqual([ANA, BOB]);
  });

  it('ignores malformed tokens', () => {
    expect(extractMentionIds('@[x](user:not-a-uuid) and @plain')).toEqual([]);
  });
});

describe('draft <-> body', () => {
  it('round-trips', () => {
    const body = `ping ${mentionToken({ userId: ANA, name: 'Ana Lee' })} now`;
    const draft = draftFromBody(body);
    expect(draft.text).toBe('ping @Ana Lee now');
    expect(serializeDraft(draft)).toBe(body);
  });

  it('drops mentions whose text was edited away', () => {
    expect(serializeDraft({ text: 'ping Ana', mentions: [{ userId: ANA, name: 'Ana Lee' }] })).toBe('ping Ana');
  });

  it('does not match inside a longer name', () => {
    expect(serializeDraft({ text: 'hi @Anabel', mentions: [{ userId: ANA, name: 'Ana' }] })).toBe('hi @Anabel');
  });

  it('maps same-named people in pick order', () => {
    const out = serializeDraft({
      text: '@Sam and @Sam',
      mentions: [
        { userId: ANA, name: 'Sam' },
        { userId: BOB, name: 'Sam' },
      ],
    });
    expect(extractMentionIds(out)).toEqual([ANA, BOB]);
  });

  it('validates empty, too long and too many mentions', () => {
    expect(validateDraft({ text: '   ', mentions: [] })).toMatch(/write something/i);
    expect(validateDraft({ text: 'a'.repeat(COMMENT_MAX_LENGTH + 1), mentions: [] })).toMatch(/at most/);
    expect(validateDraft({ text: 'ok', mentions: [] })).toBeNull();
    const many = Array.from({ length: 21 }, (_, i) => ({ userId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `P${i}` }));
    expect(validateDraft({ text: many.map((m) => `@${m.name}`).join(' '), mentions: many })).toMatch(/at most 20/);
  });
});

describe('@ autocomplete', () => {
  it('detects a query only when @ starts a word', () => {
    expect(detectMentionQuery('hi @an', 6)).toEqual({ start: 3, query: 'an' });
    expect(detectMentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(detectMentionQuery('mail me@x.com', 13)).toBeNull();
    expect(detectMentionQuery('hi @an lee', 10)).toBeNull();
    expect(detectMentionQuery('hi', 2)).toBeNull();
  });

  it('ranks prefix > word prefix > contains and excludes self', () => {
    const list: MentionCandidate[] = [
      { userId: '1', name: 'Joanna Lee', role: '' },
      { userId: '2', name: 'Lee Park', role: '' },
      { userId: '3', name: 'Ellie Ray', role: '' },
      { userId: '4', name: 'Nope', role: '' },
    ];
    expect(filterCandidates(list, 'lee').map((c) => c.userId)).toEqual(['2', '1']);
    expect(filterCandidates(list, 'll').map((c) => c.userId)).toEqual(['3']);
    expect(filterCandidates(list, '', { excludeUserId: '1', limit: 2 })).toHaveLength(2);
    expect(filterCandidates(people, 'an').map((c) => c.name)).toEqual(['Ana Lee', 'Annabel Ray']);
  });

  it('inserts the mention and moves the caret after it', () => {
    const draft = { text: 'hi @an there', mentions: [] };
    const q = detectMentionQuery(draft.text, 6)!;
    const res = applyMention(draft, q, 6, people[0]);
    expect(res.draft.text).toBe('hi @Ana Lee  there');
    expect(res.caret).toBe('hi @Ana Lee '.length);
    expect(res.draft.mentions).toEqual([{ userId: ANA, name: 'Ana Lee' }]);
  });
});

describe('threads', () => {
  const rows = [
    row({ id: 'r1', created_at: '2026-10-01T10:00:00Z' }),
    row({ id: 'a', parent_id: 'r1', created_at: '2026-10-01T11:00:00Z' }),
    row({ id: 'r2', created_at: '2026-10-01T09:00:00Z', resolved_at: '2026-10-02T09:00:00Z' }),
    row({ id: 'r3', deleted_at: '2026-10-03T00:00:00Z', created_at: '2026-10-01T12:00:00Z' }),
    row({ id: 'r4', deleted_at: '2026-10-03T00:00:00Z', created_at: '2026-10-01T13:00:00Z' }),
    row({ id: 'b', parent_id: 'r4', created_at: '2026-10-01T14:00:00Z' }),
    row({ id: 'gone', parent_id: 'r1', deleted_at: '2026-10-03T00:00:00Z', created_at: '2026-10-01T15:00:00Z' }),
  ];

  it('orders oldest-first, hides deleted leaves, keeps tombstones that have replies', () => {
    const threads = buildThreads(rows);
    expect(threads.map((t) => t.root.id)).toEqual(['r2', 'r1', 'r4']);
    expect(threads.find((t) => t.root.id === 'r1')!.replies.map((r) => r.id)).toEqual(['a']);
    expect(threads.find((t) => t.root.id === 'r2')!.resolved).toBe(true);
  });

  it('filters', () => {
    const threads = buildThreads(rows);
    expect(filterThreads(threads, 'open').map((t) => t.root.id)).toEqual(['r1', 'r4']);
    expect(filterThreads(threads, 'resolved').map((t) => t.root.id)).toEqual(['r2']);
    expect(filterThreads(threads, 'all')).toHaveLength(3);
  });

  it('upserts only into its own record and ignores stale echoes', () => {
    const scope = { type: 'job' as const, id: JOB };
    const base = [row({ id: 'x', body: 'new', updated_at: '2026-10-01T12:00:00Z' })];
    expect(upsertComment(base, row({ id: 'y', entity_id: 'other' }), scope)).toBe(base);
    expect(upsertComment(base, row({ id: 'x', body: 'old', updated_at: '2026-10-01T11:00:00Z' }), scope)).toBe(base);
    expect(upsertComment(base, row({ id: 'x', body: 'newer', updated_at: '2026-10-01T13:00:00Z' }), scope)[0].body).toBe('newer');
    expect(upsertComment(base, row({ id: 'z' }), scope)).toHaveLength(2);
  });

  it('removes a root together with its replies', () => {
    const left = removeComment([row({ id: 'r' }), row({ id: 'a', parent_id: 'r' }), row({ id: 'k' })], 'r');
    expect(left.map((r) => r.id)).toEqual(['k']);
  });
});

describe('misc', () => {
  it('builds deep links', () => {
    expect(commentEntityPath('job', 'j', 'c')).toBe('/dashboard/jobs/j?comment=c');
    expect(commentEntityPath('lead', 'l', 'c')).toBe('/dashboard/leads?lead=l&comment=c');
    expect(commentEntityPath('quote', 'q')).toBe('/dashboard/quotes/q');
  });

  it('formats relative time', () => {
    const now = new Date('2026-10-10T12:00:00Z').getTime();
    expect(relativeTime('2026-10-10T11:59:40Z', now)).toBe('just now');
    expect(relativeTime('2026-10-10T11:30:00Z', now)).toBe('30 min ago');
    expect(relativeTime('2026-10-10T09:00:00Z', now)).toBe('3h ago');
    expect(relativeTime('2026-10-08T12:00:00Z', now)).toBe('2d ago');
  });

  it('maps database errors to friendly text', () => {
    expect(describeCommentError({ message: 'thread_resolved' })).toMatch(/reopen/i);
    expect(describeCommentError({ message: 'new row violates row-level security policy' })).toMatch(/access/i);
    expect(describeCommentError({ message: 'boom' }, 'fallback')).toBe('fallback');
  });
});
