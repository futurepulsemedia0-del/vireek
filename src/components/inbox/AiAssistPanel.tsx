import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Bot, Check, X } from 'lucide-react';
import { useRealtimeSubscription } from '@/lib/realtime';
import {
  fetchConversationAiState,
  fetchPendingDraft,
  reasonLabel,
  resolveDraft,
  setConversationFlag,
  type AiChannel,
  type AiDraft,
} from '@/lib/autoReply';

interface Props {
  channel: AiChannel;
  conversationId: string;
  /** Called after a draft was sent so the thread can refetch. */
  onChanged: () => void;
}

/** Inbox strip for SMS/email threads: needs-human alert, pause-AI switch, and the pending draft to approve. */
export function AiAssistPanel({ channel, conversationId, onChanged }: Props) {
  const [state, setState] = useState({ aiPaused: false, needsHuman: false });
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, d] = await Promise.all([fetchConversationAiState(channel, conversationId), fetchPendingDraft(channel, conversationId)]);
    setState(s);
    setDraft((prev) => {
      if (d?.id !== prev?.id) setText(d?.draftBody ?? '');
      return d;
    });
  }, [channel, conversationId]);

  useEffect(() => {
    setError(null);
    load();
  }, [load]);

  useRealtimeSubscription({
    channelName: `ai-assist-${channel}-${conversationId}`,
    table: 'auto_reply_log',
    event: '*',
    filter: `conversation_id=eq.${conversationId}`,
    onChange: () => load(),
  });

  const act = async (action: 'approve' | 'reject') => {
    if (!draft || busy) return;
    setBusy(true);
    setError(null);
    const res = await resolveDraft(action, draft.id, action === 'approve' ? text : undefined);
    if (res.ok) {
      await load();
      if (action === 'approve') onChanged();
    } else {
      setError(res.error ?? 'Something went wrong');
      await load();
    }
    setBusy(false);
  };

  const toggle = async (patch: { ai_paused?: boolean; needs_human?: boolean }) => {
    if (await setConversationFlag(channel, conversationId, patch)) await load();
  };

  return (
    <div className="space-y-2 border-b border-border px-5 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
          <Bot size={13} /> AI assistant {state.aiPaused ? 'paused for this conversation' : 'active'}
        </p>
        <button
          type="button"
          onClick={() => toggle({ ai_paused: !state.aiPaused })}
          className="focus-ring rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-text-secondary hover:text-text-primary"
        >
          {state.aiPaused ? 'Resume AI' : 'Pause AI'}
        </button>
      </div>

      {state.needsHuman && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-text-primary">
          <span className="flex items-center gap-1.5"><AlertTriangle size={13} className="text-amber-500" /> This customer needs a person.</span>
          <button type="button" onClick={() => toggle({ needs_human: false })} className="focus-ring font-semibold text-accent">Mark handled</button>
        </div>
      )}

      {draft && (
        <div className="rounded-xl border border-accent/30 bg-accent/5 p-3">
          <p className="text-xs font-semibold text-text-primary">
            AI draft{draft.confidence !== null ? ` · ${Math.round(draft.confidence * 100)}% confidence` : ''}
            {draft.reason ? ` · ${reasonLabel(draft.reason)}` : ''}
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            aria-label="AI draft reply"
            className="focus-ring mt-2 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
          />
          {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy || !text.trim()}
              onClick={() => act('approve')}
              className="focus-ring flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
            >
              <Check size={13} /> Approve &amp; send
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => act('reject')}
              className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-40"
            >
              <X size={13} /> Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
