/**
 * Pest Ops — notification adapter. The app never talks to an SMS / email provider directly:
 * a worker claims due rows from pest_visit_notices and calls a NoticeNotifier. Only the mock ships
 * here; a real provider adapter must implement the same interface (credentials stay in server env,
 * never in this repo).
 */

export type NoticeChannel = 'email' | 'sms';
export type NoticeKind = 'pre_visit' | 'report';

export interface OutboundNotice {
  /** Stable per (kind, job, channel): a provider that supports idempotency keys should receive it. */
  idempotencyKey: string;
  channel: NoticeChannel;
  to: string;
  subject: string;
  body: string;
}

export type SendResult = { ok: true; providerId: string } | { ok: false; retryable: boolean; error: string };

export interface NoticeNotifier {
  readonly name: string;
  send(notice: OutboundNotice): Promise<SendResult>;
}

/** In-memory adapter for tests and local development. Never sends anything. */
export class MockNotifier implements NoticeNotifier {
  readonly name = 'mock';
  readonly sent: OutboundNotice[] = [];
  private readonly seen = new Map<string, string>();
  /** Set to make the next sends fail, to exercise retry paths. */
  failWith: { retryable: boolean; error: string } | null = null;

  async send(notice: OutboundNotice): Promise<SendResult> {
    if (this.failWith) return { ok: false, ...this.failWith };
    const existing = this.seen.get(notice.idempotencyKey);
    if (existing) return { ok: true, providerId: existing }; // replay → same id, nothing re-sent
    const providerId = `mock_${this.sent.length + 1}`;
    this.seen.set(notice.idempotencyKey, providerId);
    this.sent.push(notice);
    return { ok: true, providerId };
  }
}

export const MAX_NOTICE_ATTEMPTS = 5;

/** Exponential back-off in minutes for attempt N (1-based): 5, 15, 45, 135, 405. */
export function retryDelayMinutes(attempt: number): number {
  return 5 * 3 ** Math.max(attempt - 1, 0);
}
