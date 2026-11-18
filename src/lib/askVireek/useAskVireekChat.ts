// src/lib/askVireek/useAskVireekChat.ts
//
// Conversation controller: streaming, retry, stop, feedback, persistence.
// All pure transitions live in ./state; all I/O in ./client and ./storage.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { askSiteAssistant, type FailureKind } from './client';
import { chatReducer, toHistory, toStored, type ChatMessage } from './state';
import { clearConversation, loadConversation, saveConversation } from './storage';

export const MAX_INPUT_CHARS = 500; // mirrors MAX_MESSAGE_LENGTH in supabase/functions/site-assistant

export interface ChatApi {
  messages: ChatMessage[];
  thinking: boolean;
  streaming: boolean;
  failure: FailureKind | null;
  ask: (question: string) => Promise<void>;
  retry: () => Promise<void>;
  stop: () => void;
  reset: () => void;
  rate: (messageId: string, rating: 1 | -1) => Promise<void>;
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useAskVireekChat(pathname: string, failureText: Record<FailureKind, string>): ChatApi {
  const [messages, dispatch] = useReducer(chatReducer, [] as ChatMessage[]);
  const [thinking, setThinking] = useState(false);
  const [failure, setFailure] = useState<FailureKind | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<ChatMessage[]>(messages);
  const hydrated = useRef(false);
  messagesRef.current = messages;

  // Restore once, after mount (never during SSR/prerender).
  useEffect(() => {
    dispatch({ type: 'restore', messages: loadConversation() });
    hydrated.current = true;
  }, []);

  // Persist settled conversations only.
  useEffect(() => {
    if (!hydrated.current) return;
    if (messages.some((m) => m.streaming)) return;
    saveConversation(messages.map(toStored));
  }, [messages]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(
    async (question: string, appendUser: boolean) => {
      const text = question.trim().slice(0, MAX_INPUT_CHARS);
      if (!text) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const history = toHistory(appendUser ? messagesRef.current : messagesRef.current.slice(0, -1));
      const assistantId = newId();
      if (appendUser) dispatch({ type: 'user', id: newId(), text, at: Date.now() });
      setFailure(null);
      setThinking(true);

      await askSiteAssistant({
        message: text,
        history,
        page: pathname,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.delta) {
            setThinking(false);
          }
          dispatch({ type: 'event', id: assistantId, event, at: Date.now() });
          if (event.done) setThinking(false);
        },
        onFailure: (kind, serverMessage) => {
          setThinking(false);
          setFailure(kind);
          dispatch({ type: 'fail', id: assistantId, text: kind === 'error' && serverMessage ? serverMessage : failureText[kind], at: Date.now() });
        },
      });
      if (controller.signal.aborted) return;
      setThinking(false);
      dispatch({ type: 'finish', id: assistantId });
    },
    [pathname, failureText],
  );

  const ask = useCallback((q: string) => run(q, true), [run]);

  const retry = useCallback(async () => {
    const list = messagesRef.current;
    const last = list[list.length - 1];
    if (!last || !last.isError) return;
    const lastUser = [...list].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    dispatch({ type: 'drop-error' });
    await run(lastUser.text, false);
  }, [run]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setThinking(false);
    const last = messagesRef.current[messagesRef.current.length - 1];
    if (last?.streaming) dispatch({ type: 'stop', id: last.id });
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setThinking(false);
    setFailure(null);
    dispatch({ type: 'reset' });
    clearConversation();
  }, []);

  const rate = useCallback(async (messageId: string, rating: 1 | -1) => {
    const msg = messagesRef.current.find((m) => m.id === messageId);
    if (!msg?.answerId || msg.rating) return;
    dispatch({ type: 'rate', id: messageId, rating });
    // Anonymous, once per answer, enforced in the database (submit_site_assistant_feedback).
    await supabase.rpc('submit_site_assistant_feedback', { p_answer_id: msg.answerId, p_rating: rating });
  }, []);

  const streaming = useMemo(() => messages.some((m) => m.streaming), [messages]);
  return { messages, thinking, streaming, failure, ask, retry, stop, reset, rate };
}
