import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Send, Sparkles } from 'lucide-react';
import { useHomeowner } from '@/contexts/HomeownerAuthContext';
import { askAssistant, updateSettings } from '@/lib/homeowner/api';
import type { AssistantMessage } from '@/lib/homeowner/types';
import { Card, cx, ErrorNote, PrimaryButton } from './ui';

const SUGGESTIONS = [
  'When is my next appointment?',
  'Do I owe anything right now?',
  'Which of my equipment is under warranty?',
  'What should I maintain this season?',
];

export function HomeAssistantPage() {
  const { overview, refresh } = useHomeowner();
  const aiEnabled = overview?.profile?.ai_enabled ?? false;
  const hasProviders = (overview?.businesses ?? []).some((b) => b.live);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [messages, busy]);

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateSettings({ aiEnabled: true });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not turn on the assistant.');
    } finally {
      setBusy(false);
    }
  };

  const send = async (text: string) => {
    const message = text.trim();
    if (message.length < 2 || busy) return;
    const history = messages;
    setMessages([...history, { role: 'user', content: message }]);
    setInput('');
    setBusy(true);
    setError(null);
    try {
      const res = await askAssistant({ message, history });
      setMessages((cur) => [...cur, { role: 'assistant', content: res.answer }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The assistant couldn’t answer.');
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  if (!aiEnabled) {
    return (
      <Card className="space-y-3">
        <Sparkles size={28} className="text-accent" aria-hidden />
        <h1 className="text-xl font-semibold text-text-primary">Home assistant</h1>
        <p className="text-sm text-text-secondary">
          Ask questions about your appointments, invoices, equipment and warranties. To answer, the assistant reads{' '}
          <strong>only what you’ve chosen to share</strong> with each provider, and it is sent to an AI service for that
          request. Conversations are not stored. You can turn this off any time in Privacy.
        </p>
        {error && <ErrorNote message={error} />}
        <PrimaryButton busy={busy} onClick={() => void enable()}>Turn on the assistant</PrimaryButton>
      </Card>
    );
  }

  return (
    <div className="flex min-h-[70vh] flex-col">
      <header className="mb-3">
        <h1 className="text-2xl font-semibold text-text-primary">Home assistant</h1>
        <p className="text-xs text-text-secondary">
          AI can make mistakes. In an emergency (gas smell, fire, CO alarm) call your local emergency number first.
        </p>
      </header>

      {!hasProviders && (
        <Card className="mb-3">
          <p className="text-sm text-text-secondary">
            Connect and share data with a provider first so the assistant has something to work with.{' '}
            <Link to="/home/businesses" className="font-semibold text-accent underline">Providers</Link>
          </p>
        </Card>
      )}

      <div className="flex-1 space-y-3" aria-live="polite">
        {messages.length === 0 && (
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" onClick={() => void send(s)} className="focus-ring rounded-full bg-bg-tertiary px-3.5 py-2 text-sm text-text-primary">
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={cx(
              'max-w-[88%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm',
              m.role === 'user' ? 'ml-auto bg-accent text-white' : 'bg-bg-secondary text-text-primary border border-border',
            )}
          >
            {m.content}
          </div>
        ))}
        {busy && <p className="text-xs text-text-secondary">Thinking…</p>}
        {error && <ErrorNote message={error} />}
        <div ref={endRef} />
      </div>

      <form onSubmit={onSubmit} className="sticky bottom-20 mt-3 flex gap-2 bg-bg-primary pt-2">
        <input
          aria-label="Message"
          value={input}
          maxLength={600}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your home…"
          className="focus-ring min-w-0 flex-1 rounded-xl border border-border bg-bg-secondary px-3.5 py-3 text-sm text-text-primary"
        />
        <PrimaryButton type="submit" disabled={busy || input.trim().length < 2} aria-label="Send message">
          <Send size={16} aria-hidden />
        </PrimaryButton>
      </form>
    </div>
  );
}
