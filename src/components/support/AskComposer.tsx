// src/components/support/AskComposer.tsx
// Ask-tab composer: send / stop, 500-char counter, offline notice and a "talk to a person" hint.

import { useEffect, useState, type RefObject } from 'react';
import { Send, Square, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/Button';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  /** A reply is being prepared or streamed. */
  busy: boolean;
  maxLength: number;
  inputRef: RefObject<HTMLInputElement>;
  /** Show the "Need a person?" hint (after a couple of answers). */
  showHumanHint: boolean;
  onTalkToTeam: () => void;
}

export function AskComposer({ value, onChange, onSubmit, onStop, busy, maxLength, inputRef, showHumanHint, onTalkToTeam }: Props) {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  const nearLimit = value.length >= Math.floor(maxLength * 0.8);
  const canSend = online && value.trim().length > 0 && !busy;

  return (
    <div className="border-t border-border/80">
      {!online && (
        <p role="status" className="flex items-center gap-1.5 bg-bg-tertiary px-4 py-1.5 text-xs text-text-secondary">
          <WifiOff size={13} aria-hidden="true" /> You’re offline. Reconnect to send a message.
        </p>
      )}
      {showHumanHint && (
        <p className="px-4 pt-2 text-xs text-text-secondary">
          Need a person?{' '}
          <button type="button" onClick={onTalkToTeam} className="focus-ring font-semibold text-accent hover:underline">
            Talk to our team
          </button>
        </p>
      )}
      <form
        onSubmit={(e) => { e.preventDefault(); if (canSend) onSubmit(); }}
        className="flex items-center gap-2 p-3"
      >
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={maxLength}
          autoComplete="off"
          enterKeyHint="send"
          aria-label="Ask Vireek Support"
          aria-describedby={nearLimit ? 'vk-agent-count' : undefined}
          placeholder="Ask anything about Vireek…"
          className="focus-ring min-h-touch flex-1 rounded-control border border-border bg-bg-primary px-3.5 text-sm text-text-primary"
        />
        {busy ? (
          <Button type="button" iconOnly size="md" variant="secondary" aria-label="Stop generating" onClick={onStop}>
            <Square size={14} fill="currentColor" aria-hidden="true" />
          </Button>
        ) : (
          <Button type="submit" iconOnly size="md" variant="primary" aria-label="Send" disabled={!canSend}>
            <Send size={16} aria-hidden="true" />
          </Button>
        )}
      </form>
      {nearLimit && (
        <p id="vk-agent-count" className="px-4 pb-2 text-end text-xs text-text-secondary">
          {value.length}/{maxLength}
        </p>
      )}
    </div>
  );
}
