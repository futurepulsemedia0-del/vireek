/* ------------------------------------------------------------------ */
/*  messageCatalog — typed keys for error / success / empty / confirm   */
/*  copy. Strings live in locales/<lng>/dashboard.json under            */
/*  messages.<kind>.<id>.<part> (see docs/voice-and-tone.md).           */
/* ------------------------------------------------------------------ */

export interface MessageParts {
  error: 'title' | 'body' | 'action';
  success: 'title';
  empty: 'title' | 'body' | 'action';
  confirm: 'title' | 'body' | 'confirm' | 'cancel';
}

export type MessageKind = keyof MessageParts;

/** messageKey('error', 'saveFailed', 'title') → "messages.error.saveFailed.title" (dashboard namespace). */
export function messageKey<K extends MessageKind>(kind: K, id: string, part: MessageParts[K]): string {
  return `messages.${kind}.${id}.${part}`;
}
