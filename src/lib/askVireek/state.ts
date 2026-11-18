// src/lib/askVireek/state.ts
//
// Pure reducer for the assistant conversation (no React, no I/O) so streaming,
// retry, handoff flags and feedback state are unit-testable.

import type { HandoffReason, SiteAssistantEvent } from './client';
import type { StoredMessage } from './storage';

export interface ChatMessage extends StoredMessage {
  streaming?: boolean;
  handoffReason?: HandoffReason;
  rating?: 1 | -1;
}

export type ChatAction =
  | { type: 'restore'; messages: ChatMessage[] }
  | { type: 'user'; id: string; text: string; at: number }
  | { type: 'event'; id: string; event: SiteAssistantEvent; at: number }
  | { type: 'fail'; id: string; text: string; at: number }
  | { type: 'finish'; id: string }
  | { type: 'stop'; id: string }
  | { type: 'rate'; id: string; rating: 1 | -1 }
  | { type: 'drop-error' }
  | { type: 'reset' };

function upsertAssistant(state: ChatMessage[], id: string, at: number, patch: (m: ChatMessage) => ChatMessage): ChatMessage[] {
  const i = state.findIndex((m) => m.id === id);
  if (i === -1) return [...state, patch({ id, role: 'assistant', text: '', at, streaming: true })];
  const next = state.slice();
  next[i] = patch(next[i]);
  return next;
}

export function chatReducer(state: ChatMessage[], action: ChatAction): ChatMessage[] {
  switch (action.type) {
    case 'restore':
      return action.messages.map((m) => ({ ...m, streaming: false }));
    case 'user':
      return [...state, { id: action.id, role: 'user', text: action.text, at: action.at }];
    case 'event': {
      const e = action.event;
      return upsertAssistant(state, action.id, action.at, (m) => ({
        ...m,
        text: e.delta ? m.text + e.delta : m.text,
        answerId: e.answerId ?? m.answerId,
        sources: e.sources ?? m.sources,
        suggestions: e.suggestions ?? m.suggestions,
        handoff: e.handoff ? true : m.handoff,
        handoffReason: e.handoff?.reason ?? m.handoffReason,
        streaming: e.done ? false : m.streaming,
      }));
    }
    case 'fail':
      return upsertAssistant(state, action.id, action.at, (m) => ({ ...m, text: m.text ? `${m.text}\n\n${action.text}` : action.text, isError: true, streaming: false }));
    case 'finish':
    case 'stop':
      return state.map((m) => (m.id === action.id ? { ...m, streaming: false } : m));
    case 'rate':
      return state.map((m) => (m.id === action.id && !m.rating ? { ...m, rating: action.rating } : m));
    case 'drop-error': {
      // Retry: remove a trailing error reply (and keep the user turn so it is re-sent).
      const last = state[state.length - 1];
      return last && last.role === 'assistant' && last.isError ? state.slice(0, -1) : state;
    }
    case 'reset':
      return [];
  }
}

/** History sent to the server: finished, non-error turns only, capped. */
export function toHistory(messages: ChatMessage[], maxTurns = 6): { role: 'user' | 'assistant'; content: string }[] {
  return messages
    .filter((m) => !m.isError && !m.streaming && m.text.trim())
    .slice(-maxTurns * 2)
    .map((m) => ({ role: m.role, content: m.text.slice(0, 500) }));
}

/** Drops transient UI fields before persisting. */
export function toStored(m: ChatMessage): StoredMessage {
  const out: StoredMessage = { id: m.id, role: m.role, text: m.text, at: m.at };
  if (m.isError) out.isError = true;
  if (m.answerId) out.answerId = m.answerId;
  if (m.sources) out.sources = m.sources;
  if (m.suggestions) out.suggestions = m.suggestions;
  if (m.handoff) out.handoff = true;
  return out;
}
