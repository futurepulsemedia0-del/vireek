import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  BrainCircuit,
  ChevronDown,
  Cpu,
  Lock,
  MessageSquarePlus,
  Send,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import {
  OWNER_LABEL,
  SUGGESTED_QUESTIONS,
  URGENCY_LABEL,
  askVireek,
  deleteConversation,
  formatEvidenceValue,
  formatUsd,
  listConversations,
  loadConversation,
  prettyEvidenceRef,
  sendFeedback,
  type BrainAnswer,
  type ChatTurn,
  type ConversationSummary,
  type Verdict,
} from '@/lib/askVireek';

const MAX_QUESTION = 500;

const VERDICT_STYLE: Record<Verdict, { label: string; className: string } | null> = {
  yes: { label: 'Yes', className: 'bg-emerald-500/10 text-emerald-500' },
  no: { label: 'No', className: 'bg-danger/10 text-danger' },
  conditional: { label: 'Only if…', className: 'bg-amber-500/10 text-amber-500' },
  info: null,
};

const CONFIDENCE_STYLE = {
  high: 'bg-emerald-500/10 text-emerald-500',
  medium: 'bg-amber-500/10 text-amber-500',
  low: 'bg-danger/10 text-danger',
} as const;

const localId = () => `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const isPersisted = (id: string) => !id.startsWith('local-');

// ---------------------------------------------------------------
// Answer card
// ---------------------------------------------------------------

function AnswerView({
  answer,
  messageId,
  feedback,
  onFeedback,
  onFollowUp,
  disabled,
}: {
  answer: BrainAnswer;
  messageId: string;
  feedback: ChatTurn['feedback'];
  onFeedback: (id: string, value: 'helpful' | 'not_helpful') => void;
  onFollowUp: (q: string) => void;
  disabled: boolean;
}) {
  const [showEvidence, setShowEvidence] = useState(false);
  const verdict = answer.verdict ? VERDICT_STYLE[answer.verdict] : null;
  const asOf = new Date(answer.as_of);

  return (
    <Card className="!p-5 hover:!translate-y-0">
      <div className="flex flex-wrap items-center gap-2">
        {verdict && (
          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${verdict.className}`}>{verdict.label}</span>
        )}
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${CONFIDENCE_STYLE[answer.confidence.level]}`}
          title={answer.confidence.reason}
        >
          {answer.confidence.level} confidence
        </span>
        <span className="flex items-center gap-1 text-xs text-text-secondary">
          {answer.source === 'ai' ? <ShieldCheck size={13} /> : <Cpu size={13} />}
          {answer.source === 'ai' ? 'Numbers verified against your records' : 'Computed directly from your records'}
        </span>
      </div>

      <h2 dir="auto" className="mt-3 text-lg font-semibold leading-snug text-text-primary">
        {answer.headline}
      </h2>
      <p dir="auto" className="mt-2 whitespace-pre-line text-sm leading-relaxed text-text-secondary">
        {answer.answer}
      </p>

      {answer.findings.length > 0 && (
        <ul className="mt-4 space-y-2">
          {answer.findings.map((f, i) => (
            <li key={`${f.title}-${i}`} className="rounded-xl border border-border bg-bg-primary p-3">
              <div className="flex items-start justify-between gap-3">
                <p dir="auto" className="text-sm font-semibold text-text-primary">
                  {f.title}
                </p>
                {f.impact_usd !== null && (
                  <span
                    className={`shrink-0 text-sm font-semibold ${f.impact_usd < 0 ? 'text-danger' : 'text-emerald-500'}`}
                  >
                    {f.impact_usd > 0 ? '+' : ''}
                    {formatUsd(f.impact_usd)}
                  </span>
                )}
              </div>
              <p dir="auto" className="mt-1 text-sm text-text-secondary">
                {f.detail}
              </p>
            </li>
          ))}
        </ul>
      )}

      {answer.actions.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Recommended actions</p>
          <ol className="space-y-2">
            {answer.actions.map((a, i) => (
              <li key={`${a.action}-${i}`} className="flex items-start gap-3 text-sm">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-semibold text-accent">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p dir="auto" className="text-text-primary">
                    {a.action}
                  </p>
                  <p className="mt-0.5 text-xs text-text-secondary">
                    {OWNER_LABEL[a.owner]} · {URGENCY_LABEL[a.urgency]}
                    {a.expected_impact_usd !== null && ` · about ${formatUsd(a.expected_impact_usd)}`}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {(answer.assumptions.length > 0 || answer.data_gaps.length > 0) && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {answer.assumptions.length > 0 && (
            <div className="rounded-xl bg-bg-primary p-3 text-xs text-text-secondary">
              <p className="mb-1 font-semibold text-text-primary">Assumptions</p>
              <ul className="list-inside list-disc space-y-0.5">
                {answer.assumptions.map((s, i) => (
                  <li key={i} dir="auto">
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {answer.data_gaps.length > 0 && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-text-secondary">
              <p className="mb-1 flex items-center gap-1 font-semibold text-amber-500">
                <AlertTriangle size={13} /> Data gaps
              </p>
              <ul className="list-inside list-disc space-y-0.5">
                {answer.data_gaps.map((s, i) => (
                  <li key={i} dir="auto">
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {answer.evidence.length > 0 && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowEvidence((s) => !s)}
            aria-expanded={showEvidence}
            className="focus-ring flex items-center gap-1 text-xs font-medium text-text-secondary hover:text-text-primary"
          >
            <ChevronDown size={14} className={`transition-transform ${showEvidence ? 'rotate-180' : ''}`} />
            Evidence ({answer.evidence.length})
          </button>
          {showEvidence && (
            <dl className="mt-2 divide-y divide-border rounded-xl border border-border text-xs">
              {answer.evidence.map((e) => (
                <div key={e.ref} className="flex items-center justify-between gap-3 px-3 py-2">
                  <dt className="text-text-secondary">{prettyEvidenceRef(e.ref)}</dt>
                  <dd className="font-medium text-text-primary">{formatEvidenceValue(e.value)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}

      {answer.follow_ups.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {answer.follow_ups.map((q) => (
            <button
              key={q}
              type="button"
              disabled={disabled}
              onClick={() => onFollowUp(q)}
              dir="auto"
              className="focus-ring rounded-full border border-border px-3 py-1.5 text-xs font-medium text-text-primary hover:border-accent/40 hover:bg-bg-tertiary disabled:opacity-50"
            >
              {q}
            </button>
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-text-secondary">
        <span>
          As of {asOf.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · {answer.coverage.completed_jobs} completed jobs
          analysed
          {answer.coverage.costed_jobs_pct !== null && ` · ${answer.coverage.costed_jobs_pct}% have cost data`}
        </span>
        {isPersisted(messageId) && (
          <span className="flex items-center gap-1">
            <button
              type="button"
              aria-label="This answer was helpful"
              aria-pressed={feedback === 'helpful'}
              onClick={() => onFeedback(messageId, 'helpful')}
              className={`focus-ring rounded-lg p-1.5 hover:bg-bg-tertiary ${feedback === 'helpful' ? 'text-emerald-500' : ''}`}
            >
              <ThumbsUp size={15} />
            </button>
            <button
              type="button"
              aria-label="This answer was not helpful"
              aria-pressed={feedback === 'not_helpful'}
              onClick={() => onFeedback(messageId, 'not_helpful')}
              className={`focus-ring rounded-lg p-1.5 hover:bg-bg-tertiary ${feedback === 'not_helpful' ? 'text-danger' : ''}`}
            >
              <ThumbsDown size={15} />
            </button>
          </span>
        )}
      </div>
    </Card>
  );
}

function ThinkingCard() {
  return (
    <Card className="!p-5 hover:!translate-y-0" aria-live="polite" aria-busy="true">
      <p className="mb-3 text-sm font-medium text-text-secondary">Analysing your jobs, costs, calls and customers…</p>
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="mt-2 h-4 w-full" />
      <Skeleton className="mt-2 h-4 w-2/3" />
    </Card>
  );
}

// ---------------------------------------------------------------
// Page
// ---------------------------------------------------------------

export function AskVireekPage() {
  const { permissions, isOwner } = useAuth();
  const { toast } = useToast();
  const canUse = isOwner || permissions.can_view_billing;

  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await listConversations());
    } catch {
      /* history is a convenience; the page works without it */
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canUse) void refreshConversations();
    else setHistoryLoading(false);
  }, [canUse, refreshConversations]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns.length, sending]);

  const ask = useCallback(
    async (raw: string) => {
      const question = raw.trim();
      if (question.length < 2 || sendingRef.current) return;
      if (question.length > MAX_QUESTION) {
        toast(`Keep questions under ${MAX_QUESTION} characters.`, 'error');
        return;
      }
      sendingRef.current = true;
      setSending(true);
      setInput('');
      setTurns((t) => [...t, { id: localId(), role: 'user', content: question }]);
      try {
        const res = await askVireek(question, conversationId);
        setTurns((t) => [
          ...t,
          {
            id: res.messageId ?? localId(),
            role: 'assistant',
            content: res.answer.headline,
            answer: res.answer,
            feedback: null,
          },
        ]);
        if (res.conversationId && res.conversationId !== conversationId) setConversationId(res.conversationId);
        void refreshConversations();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Ask Vireek could not answer right now.';
        setTurns((t) => [...t, { id: localId(), role: 'assistant', content: message, error: true }]);
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [conversationId, refreshConversations, toast],
  );

  const handleFeedback = useCallback(
    async (messageId: string, value: 'helpful' | 'not_helpful') => {
      setTurns((t) => t.map((x) => (x.id === messageId ? { ...x, feedback: value } : x)));
      try {
        await sendFeedback(messageId, value);
      } catch {
        setTurns((t) => t.map((x) => (x.id === messageId ? { ...x, feedback: null } : x)));
        toast('Could not save your feedback.', 'error');
      }
    },
    [toast],
  );

  const openConversation = async (id: string) => {
    if (sendingRef.current) return;
    try {
      const loaded = await loadConversation(id);
      setTurns(loaded);
      setConversationId(id);
    } catch {
      toast('Could not open that conversation.', 'error');
    }
  };

  const newConversation = () => {
    if (sendingRef.current) return;
    setTurns([]);
    setConversationId(null);
    setInput('');
  };

  const removeConversation = async (id: string) => {
    try {
      await deleteConversation(id);
      setConversations((c) => c.filter((x) => x.id !== id));
      if (id === conversationId) newConversation();
    } catch {
      toast('Could not delete that conversation.', 'error');
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void ask(input);
    }
  };

  if (!canUse) {
    return (
      <DashboardLayout activeLabel="Ask Vireek">
        <EmptyState
          icon={Lock}
          title="Ask Vireek needs billing access"
          description="Answers include revenue, profit and customer data. Ask the account owner to give you billing permission."
        />
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Ask Vireek">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <BrainCircuit size={24} />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Ask Vireek</h1>
          <p className="text-sm text-text-secondary">
            Your business brain. Ask in plain language — every answer is calculated from your own jobs, costs, calls and customers.
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
        {/* ---------- history ---------- */}
        <aside className="order-2 lg:order-1">
          <Button variant="secondary" size="sm" className="w-full" onClick={newConversation} disabled={sending}>
            <MessageSquarePlus size={16} /> New conversation
          </Button>
          <div className="mt-3 space-y-1">
            {historyLoading ? (
              <>
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </>
            ) : conversations.length === 0 ? (
              <p className="px-1 text-xs text-text-secondary">Your past questions will appear here.</p>
            ) : (
              conversations.map((c) => (
                <div
                  key={c.id}
                  className={`group flex items-center gap-1 rounded-xl pr-1 ${c.id === conversationId ? 'bg-bg-tertiary' : 'hover:bg-bg-tertiary'}`}
                >
                  <button
                    type="button"
                    onClick={() => void openConversation(c.id)}
                    dir="auto"
                    className="focus-ring min-w-0 flex-1 truncate rounded-xl px-3 py-2 text-left text-sm text-text-primary"
                    title={c.title}
                  >
                    {c.title}
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete conversation: ${c.title}`}
                    onClick={() => void removeConversation(c.id)}
                    className="focus-ring rounded-lg p-1.5 text-text-secondary opacity-0 hover:text-danger focus:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>

        {/* ---------- conversation ---------- */}
        <section className="order-1 min-w-0 lg:order-2">
          {turns.length === 0 && !sending ? (
            <div className="space-y-4">
              <EmptyState
                icon={BrainCircuit}
                title="What do you want to know about your business?"
                description="Try one of these, or ask your own question in English, Persian, Spanish or Arabic."
              />
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTED_QUESTIONS.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => void ask(s.question)}
                    className="focus-ring rounded-full border border-border bg-bg-secondary px-4 py-2 text-sm font-medium text-text-primary hover:border-accent/40 hover:bg-bg-tertiary"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-4" role="log" aria-live="polite">
              {turns.map((t) =>
                t.role === 'user' ? (
                  <div key={t.id} className="flex justify-end">
                    <p
                      dir="auto"
                      className="max-w-[85%] whitespace-pre-line rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm text-white"
                    >
                      {t.content}
                    </p>
                  </div>
                ) : t.answer ? (
                  <AnswerView
                    key={t.id}
                    answer={t.answer}
                    messageId={t.id}
                    feedback={t.feedback}
                    onFeedback={handleFeedback}
                    onFollowUp={(q) => void ask(q)}
                    disabled={sending}
                  />
                ) : (
                  <Card key={t.id} className="!p-4 hover:!translate-y-0">
                    <p dir="auto" className={`flex items-start gap-2 text-sm ${t.error ? 'text-danger' : 'text-text-primary'}`}>
                      {t.error && <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
                      {t.content}
                    </p>
                  </Card>
                ),
              )}
              {sending && <ThinkingCard />}
              <div ref={bottomRef} />
            </div>
          )}

          <div className="sticky bottom-0 mt-6 bg-bg-primary pb-2 pt-3">
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Textarea
                  label="Ask a question"
                  rows={2}
                  maxLength={MAX_QUESTION}
                  value={input}
                  disabled={sending}
                  dir="auto"
                  placeholder="e.g. Where am I losing money?"
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKeyDown}
                  helperText="Enter to send · Shift+Enter for a new line"
                />
              </div>
              <Button
                size="md"
                className="mb-7"
                onClick={() => void ask(input)}
                disabled={sending || input.trim().length < 2}
                aria-label="Send question"
              >
                <Send size={18} />
              </Button>
            </div>
          </div>
        </section>
      </div>
    </DashboardLayout>
  );
}
