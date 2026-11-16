// src/lib/supportAgent/ticketDraft.ts
//
// Hand-off from the Support Agent to the signed-in ticket flow (/dashboard/support).
// The agent builds a ready-to-edit draft (subject, body with the sanitized diagnostic report,
// category) and parks it in sessionStorage; SupportTicketsPage PEEKS it on mount, opens the
// "new ticket" form pre-filled, and CLEARS it in an effect (peek, not take: React StrictMode
// may run initializers twice). The user reviews and submits — nothing is created automatically.
// Limits come from the real ticket validation so a draft can never fail it.

import { BODY_MAX, BODY_MIN, SUBJECT_MAX, SUBJECT_MIN, type TicketCategory } from '@/lib/supportTickets';
import type { MemoryStore } from './chatMemory';

export interface TicketDraft {
  subject: string;
  body: string;
  category: TicketCategory;
}

export const TICKET_DRAFT_KEY = 'vk_ticket_draft_v1';
const TTL_MS = 15 * 60_000;
const CATEGORIES: readonly TicketCategory[] = ['billing', 'technical', 'account', 'feature_request', 'other'];
const ACCOUNT_FINDINGS = new Set(['email_unconfirmed', 'invalid_credentials', 'session_expired', 'session_expiring', 'rate_limited']);

export interface DraftInput {
  /** Findings from the latest check (id + title), ordered by severity. */
  findings: readonly { id: string; title: string }[];
  report: string | null;
  lastQuestion: string | null;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function buildTicketDraft({ findings, report, lastQuestion }: DraftInput): TicketDraft {
  const real = findings.filter((f) => f.id !== 'healthy');
  const question = (lastQuestion ?? '').replace(/\s+/g, ' ').trim();
  let subject = real[0]?.title ?? (question ? question : 'I need help');
  subject = clip(subject.trim(), SUBJECT_MAX);
  if (subject.length < SUBJECT_MIN) subject = 'I need help';

  const parts: string[] = [];
  if (question) parts.push(`What I asked the assistant: ${question}`);
  if (real.length) parts.push(`Issues the assistant found: ${real.map((f) => f.title).join('; ')}`);
  parts.push(report ? `Diagnostic report (contains no email, password or token):\n${report}` : 'Please describe what happened here.');
  let body = parts.join('\n\n');
  if (body.length < BODY_MIN) body = `${body}\n\nPlease describe what happened here.`;

  const category: TicketCategory = real.some((f) => ACCOUNT_FINDINGS.has(f.id)) ? 'account' : 'technical';
  return { subject, body: clip(body, BODY_MAX), category };
}

export function putTicketDraft(store: MemoryStore, draft: TicketDraft, now: number = Date.now()): void {
  try { store.setItem(TICKET_DRAFT_KEY, JSON.stringify({ at: now, draft })); } catch { /* blocked: the user just types it */ }
}

/** Reads without removing. Validates and clamps everything (storage is untrusted). */
export function peekTicketDraft(store: MemoryStore, now: number = Date.now()): TicketDraft | null {
  try {
    const raw = store.getItem(TICKET_DRAFT_KEY);
    if (!raw) return null;
    const env = JSON.parse(raw) as { at?: number; draft?: Partial<TicketDraft> };
    if (typeof env?.at !== 'number' || now - env.at > TTL_MS || !env.draft) return null;
    const { subject, body, category } = env.draft;
    if (typeof subject !== 'string' || typeof body !== 'string') return null;
    return {
      subject: clip(subject, SUBJECT_MAX),
      body: clip(body, BODY_MAX),
      category: CATEGORIES.includes(category as TicketCategory) ? (category as TicketCategory) : 'technical',
    };
  } catch {
    return null;
  }
}

export function clearTicketDraft(store: MemoryStore): void {
  try { store.removeItem(TICKET_DRAFT_KEY); } catch { /* ignore */ }
}
