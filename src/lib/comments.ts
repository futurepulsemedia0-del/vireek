// Pure logic for comments + @mentions (no React, no network) so it is fully unit-tested.
//
// Storage format of a mention inside `body`:  @[Display Name](user:<uuid>)
// The database re-extracts these tokens itself and keeps only people who can
// access the record, so the client list of mentions is never trusted.

export type CommentEntityType = 'job' | 'customer' | 'quote' | 'lead';

export const COMMENT_ENTITY_LABELS: Record<CommentEntityType, string> = {
  job: 'Job',
  customer: 'Customer',
  quote: 'Quote',
  lead: 'Lead',
};

export const COMMENT_MAX_LENGTH = 4000;
export const COMMENT_MAX_MENTIONS = 20;
const NAME_MAX = 80;
const QUERY_MAX = 30;

const UUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const UUID_RE = new RegExp(`^${UUID_PATTERN}$`);
const tokenRe = () => new RegExp(`@\\[([^\\]]{1,${NAME_MAX}})\\]\\(user:(${UUID_PATTERN})\\)`, 'g');

export interface CommentRow {
  id: string;
  user_id: string;
  entity_type: CommentEntityType;
  entity_id: string;
  parent_id: string | null;
  author_id: string | null;
  author_name: string;
  body: string;
  mentions: string[];
  resolved_at: string | null;
  resolved_by: string | null;
  resolved_by_name: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MentionCandidate {
  userId: string;
  name: string;
  role: string;
}

/** A person picked from the @ list while composing. */
export interface MentionRef {
  userId: string;
  name: string;
}

/** What the textarea holds: friendly "@Name" text plus the people it refers to. */
export interface Draft {
  text: string;
  mentions: MentionRef[];
}

export const EMPTY_DRAFT: Draft = { text: '', mentions: [] };

export interface CommentThread {
  root: CommentRow;
  replies: CommentRow[];
  resolved: boolean;
}

export type ThreadFilter = 'all' | 'open' | 'resolved';

export type BodySegment =
  | { type: 'text'; text: string }
  | { type: 'mention'; userId: string; name: string };

// ---------------------------------------------------------------------------
// Names / tokens
// ---------------------------------------------------------------------------

/** Names go inside [] and (): strip anything that could break the token. */
export function sanitizeMentionName(name: string): string {
  const cleaned = name.replace(/[[\]()\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return cleaned || 'Teammate';
}

export function mentionToken(ref: MentionRef): string {
  return `@[${sanitizeMentionName(ref.name)}](user:${ref.userId.toLowerCase()})`;
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function parseBody(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  const re = tokenRe();
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    if (match.index > last) segments.push({ type: 'text', text: body.slice(last, match.index) });
    segments.push({ type: 'mention', userId: match[2].toLowerCase(), name: match[1] });
    last = match.index + match[0].length;
  }
  if (last < body.length) segments.push({ type: 'text', text: body.slice(last) });
  return segments;
}

export function extractMentionIds(body: string): string[] {
  const ids: string[] = [];
  for (const seg of parseBody(body)) {
    if (seg.type === 'mention' && !ids.includes(seg.userId)) ids.push(seg.userId);
  }
  return ids;
}

/** Body as plain text ("@Ana" instead of the token) — previews, tests, a11y. */
export function plainText(body: string): string {
  return parseBody(body)
    .map((s) => (s.type === 'text' ? s.text : `@${s.name}`))
    .join('');
}

// ---------------------------------------------------------------------------
// Draft <-> stored body
// ---------------------------------------------------------------------------

const isNameChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch);

/**
 * Turns the friendly draft ("hi @Ana Lee, ...") into the stored body by swapping
 * each picked mention for its token. Mentions whose "@Name" was edited away are
 * silently dropped; people with the same name are matched in pick order.
 */
export function serializeDraft(draft: Draft): string {
  let out = '';
  let cursor = 0;
  const text = draft.text;
  for (const ref of draft.mentions) {
    const needle = `@${ref.name}`;
    let from = cursor;
    let at = -1;
    while (from <= text.length) {
      const idx = text.indexOf(needle, from);
      if (idx === -1) break;
      const after = text[idx + needle.length];
      const before = idx > 0 ? text[idx - 1] : undefined;
      if (!isNameChar(after) && !isNameChar(before)) {
        at = idx;
        break;
      }
      from = idx + 1;
    }
    if (at === -1) continue;
    out += text.slice(cursor, at) + mentionToken(ref);
    cursor = at + needle.length;
  }
  out += text.slice(cursor);
  return out.trim();
}

/** Inverse of serializeDraft — used when editing an existing comment. */
export function draftFromBody(body: string): Draft {
  const mentions: MentionRef[] = [];
  let text = '';
  for (const seg of parseBody(body)) {
    if (seg.type === 'text') {
      text += seg.text;
    } else {
      text += `@${seg.name}`;
      mentions.push({ userId: seg.userId, name: seg.name });
    }
  }
  return { text, mentions };
}

export function draftCharCount(draft: Draft): number {
  return serializeDraft(draft).length;
}

/** null = fine, otherwise a user-facing reason the draft can't be posted. */
export function validateDraft(draft: Draft): string | null {
  const body = serializeDraft(draft);
  if (body.length === 0) return 'Write something first.';
  if (body.length > COMMENT_MAX_LENGTH) {
    return `Comments can be at most ${COMMENT_MAX_LENGTH.toLocaleString('en-US')} characters (currently ${body.length.toLocaleString('en-US')}).`;
  }
  if (extractMentionIds(body).length > COMMENT_MAX_MENTIONS) {
    return `You can mention at most ${COMMENT_MAX_MENTIONS} people in one comment.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// @ autocomplete
// ---------------------------------------------------------------------------

export interface MentionQuery {
  /** index of the "@" */
  start: number;
  query: string;
}

/** Active "@query" immediately before the caret, or null. "@" must start a word. */
export function detectMentionQuery(text: string, caret: number): MentionQuery | null {
  if (caret < 1 || caret > text.length) return null;
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf('@');
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null; // e.g. an email address
  const query = upto.slice(at + 1);
  if (query.length > QUERY_MAX || /[\s@[\]()]/.test(query)) return null;
  return { start: at, query };
}

/** Prefix of the name > prefix of any word > anywhere; stable alphabetical inside a tier. */
export function filterCandidates(
  candidates: MentionCandidate[],
  query: string,
  options: { excludeUserId?: string | null; limit?: number } = {},
): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  const limit = options.limit ?? 6;
  const rank = (c: MentionCandidate): number => {
    const name = c.name.toLowerCase();
    if (!q) return 0;
    if (name.startsWith(q)) return 0;
    if (name.split(/\s+/).some((w) => w.startsWith(q))) return 1;
    if (name.includes(q)) return 2;
    return -1;
  };
  return candidates
    .filter((c) => c.userId !== options.excludeUserId)
    .map((c) => ({ c, r: rank(c) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.c.name.localeCompare(b.c.name))
    .slice(0, limit)
    .map((x) => x.c);
}

/** Replaces the "@query" at `start` (up to `caret`) with "@Name " and registers the mention. */
export function applyMention(draft: Draft, query: MentionQuery, caret: number, person: MentionCandidate): { draft: Draft; caret: number } {
  const name = sanitizeMentionName(person.name);
  const insert = `@${name} `;
  const text = draft.text.slice(0, query.start) + insert + draft.text.slice(caret);
  const exists = draft.mentions.some((m) => m.userId === person.userId && m.name === name);
  // Keep pick order stable: new mention goes where it sits in the text.
  const mentions = exists ? draft.mentions : [...draft.mentions, { userId: person.userId, name }];
  return { draft: { text, mentions: orderMentions(text, mentions) }, caret: query.start + insert.length };
}

function orderMentions(text: string, mentions: MentionRef[]): MentionRef[] {
  // Stable sort by first free position of "@Name" in the text.
  const used = new Map<string, number>();
  const withPos = mentions.map((m, i) => {
    const needle = `@${m.name}`;
    const from = used.get(needle) ?? 0;
    const pos = text.indexOf(needle, from);
    if (pos !== -1) used.set(needle, pos + needle.length);
    return { m, i, pos: pos === -1 ? Number.MAX_SAFE_INTEGER : pos };
  });
  return withPos.sort((a, b) => a.pos - b.pos || a.i - b.i).map((x) => x.m);
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

const byCreated = (a: CommentRow, b: CommentRow) =>
  a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id.localeCompare(b.id);

/**
 * Roots oldest-first (a conversation reads top-down), replies oldest-first.
 * Deleted comments disappear — except a deleted root that still has replies,
 * which stays as a tombstone so the replies keep their context.
 */
export function buildThreads(rows: CommentRow[]): CommentThread[] {
  const roots = rows.filter((r) => r.parent_id === null).sort(byCreated);
  const repliesByRoot = new Map<string, CommentRow[]>();
  for (const r of rows) {
    if (r.parent_id === null || r.deleted_at) continue;
    const list = repliesByRoot.get(r.parent_id) ?? [];
    list.push(r);
    repliesByRoot.set(r.parent_id, list);
  }
  const threads: CommentThread[] = [];
  for (const root of roots) {
    const replies = (repliesByRoot.get(root.id) ?? []).sort(byCreated);
    if (root.deleted_at && replies.length === 0) continue;
    threads.push({ root, replies, resolved: root.resolved_at !== null && !root.deleted_at });
  }
  return threads;
}

export function filterThreads(threads: CommentThread[], filter: ThreadFilter): CommentThread[] {
  if (filter === 'open') return threads.filter((t) => !t.resolved);
  if (filter === 'resolved') return threads.filter((t) => t.resolved);
  return threads;
}

export function countOpenThreads(threads: CommentThread[]): number {
  return threads.filter((t) => !t.resolved).length;
}

/** Insert-or-replace by id, ignoring rows that belong to another record. Returns the same array if nothing changed. */
export function upsertComment(rows: CommentRow[], next: CommentRow, scope: { type: CommentEntityType; id: string }): CommentRow[] {
  if (next.entity_type !== scope.type || next.entity_id !== scope.id) return rows;
  const idx = rows.findIndex((r) => r.id === next.id);
  if (idx === -1) return [...rows, next];
  const current = rows[idx];
  if (current.updated_at > next.updated_at) return rows; // stale echo of our own earlier write
  const copy = rows.slice();
  copy[idx] = next;
  return copy;
}

export function removeComment(rows: CommentRow[], id: string): CommentRow[] {
  return rows.some((r) => r.id === id) ? rows.filter((r) => r.id !== id && r.parent_id !== id) : rows;
}

// ---------------------------------------------------------------------------
// Links / time / errors
// ---------------------------------------------------------------------------

export function commentEntityPath(type: CommentEntityType, id: string, commentId?: string): string {
  const base =
    type === 'job'
      ? `/dashboard/jobs/${id}`
      : type === 'customer'
        ? `/dashboard/customers/${id}`
        : type === 'quote'
          ? `/dashboard/quotes/${id}`
          : `/dashboard/leads?lead=${id}`;
  if (!commentId) return base;
  return `${base}${base.includes('?') ? '&' : '?'}comment=${commentId}`;
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: days > 300 ? 'numeric' : undefined });
}

/** Maps database / network errors to something a person can act on. */
export function describeCommentError(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const message = (error as { message?: string } | null)?.message ?? '';
  if (message.includes('thread_resolved')) return 'This thread is resolved. Reopen it to reply.';
  if (message.includes('comment_deleted')) return 'That comment was deleted.';
  if (message.includes('invalid_parent')) return 'The comment you replied to is no longer available.';
  if (message.includes('too_many_mentions')) return `You can mention at most ${COMMENT_MAX_MENTIONS} people in one comment.`;
  if (message.includes('not_allowed')) return "You don't have permission to do that.";
  if (message.includes('entity_not_found') || message.includes('row-level security')) {
    return "You don't have access to comment on this record.";
  }
  if (message.includes('entity_comments_body_len')) return `Comments must be between 1 and ${COMMENT_MAX_LENGTH.toLocaleString('en-US')} characters.`;
  return fallback;
}
