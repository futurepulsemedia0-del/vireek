// src/lib/askVireek/handoff.ts
//
// One-tap hand-off from "Ask Vireek" to a human: live chat (with the transcript, so
// the visitor never repeats themselves) or a support ticket / contact form.

import type { StoredMessage } from './storage';

export const OPEN_ASSISTANT_EVENT = 'vireek:open-assistant';
export const OPEN_LIVE_CHAT_EVENT = 'vireek:open-live-chat';
export const OPEN_ACCOUNT_ASSISTANT_EVENT = 'vireek:open-account-assistant';

export const TRANSCRIPT_MAX_CHARS = 1800;
export const TRANSCRIPT_MAX_TURNS = 8;

export interface LiveChatHandoffDetail {
  source: 'ask-vireek';
  /** Last question the visitor asked (prefilled into the live-chat composer). */
  lastQuestion?: string;
  /** Redaction-free transcript of the most recent turns, truncated at a turn boundary. */
  transcript?: string;
}

export interface OpenAssistantDetail {
  /** Question to send immediately. */
  ask?: string;
  /** Prefill the composer without sending. */
  prefill?: string;
  /** Page-specific context label shown in the composer ("Ask about pricing"). */
  topic?: string;
}

/** Last `maxTurns` non-error messages as "Visitor:/Ask Vireek:" lines, newest kept, capped by size. */
export function buildTranscript(messages: StoredMessage[], maxChars = TRANSCRIPT_MAX_CHARS, maxTurns = TRANSCRIPT_MAX_TURNS): string {
  const lines = messages
    .filter((m) => !m.isError && m.text.trim())
    .slice(-maxTurns)
    .map((m) => `${m.role === 'user' ? 'Visitor' : 'Ask Vireek'}: ${m.text.trim().replace(/\s+/g, ' ')}`);
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].length > 600 ? `${lines[i].slice(0, 597)}...` : lines[i];
    if (total + line.length + 1 > maxChars) break;
    kept.unshift(line);
    total += line.length + 1;
  }
  return kept.join('\n');
}

export function lastUserQuestion(messages: StoredMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i].text.slice(0, 300);
  return undefined;
}

export function buildLiveChatDetail(messages: StoredMessage[]): LiveChatHandoffDetail {
  return { source: 'ask-vireek', lastQuestion: lastUserQuestion(messages), transcript: buildTranscript(messages) };
}

/** Message placed in the live-chat composer; the full transcript is attached as context text. */
export function liveChatPrefill(detail: LiveChatHandoffDetail): string {
  const q = detail.lastQuestion?.trim();
  const head = q ? `I was asking Ask Vireek: "${q}" and would like to talk to a person.` : 'I would like to talk to a person.';
  return detail.transcript ? `${head}\n\n--- Conversation so far ---\n${detail.transcript}` : head;
}

/** Support ticket target: signed-in users file a ticket in the dashboard, visitors use the contact form. */
export function ticketHref(signedIn: boolean): string {
  return signedIn ? '/dashboard/support' : '/contact';
}

let pending: OpenAssistantDetail | null = null;

/** Opens the assistant from anywhere. If its lazy chunk has not mounted yet, the request is kept and consumed on mount. */
export function openAssistant(detail: OpenAssistantDetail = {}): void {
  pending = detail;
  window.dispatchEvent(new CustomEvent<OpenAssistantDetail>(OPEN_ASSISTANT_EVENT, { detail }));
}

export function consumePendingOpen(): OpenAssistantDetail | null {
  const d = pending;
  pending = null;
  return d;
}
