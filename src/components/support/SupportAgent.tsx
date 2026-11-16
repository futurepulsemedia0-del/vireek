// src/components/support/SupportAgent.tsx
//
// Vireek Support Agent — the single floating support entry point for public pages.
// Three tabs: Ask (streaming AI, grounded in product knowledge + sanitized diagnostics),
// Fix (guided troubleshooting → confirmed automated fixes → verified self-healing),
// Team (human chat, email, copyable diagnostic report with an incident ID).
//
// PLACEMENT: sits on the same right rail as the Accessibility Center, stacked ONE slot above
// it (never over it). It hides while the Accessibility Center is open (data-a11y-open on
// <html>) and closes itself if that panel opens, so the two can never overlap.
// Mounted once in src/main.tsx. Hidden on app/staff/portal/wallboard routes.

import { KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Copy, Mail, MessageCircle, Send, Wrench, X, Sparkles } from 'lucide-react';
import { streamAiChat } from '@/lib/aiStream';
import { buildSupportMailto, generateIncidentId } from '@/lib/incident';
import { getSupportStatus, SUPPORT_HOURS_LABEL } from '@/lib/supportHours';
import { usePrefersReducedMotion } from '@/lib/usePrefersReducedMotion';
import { Button } from '@/components/ui/Button';
import { ChatAvatar, MessageBubble, OnlineDot, StarterPromptChip, TypingIndicator } from '@/components/chat/ChatVisuals';
import { SupportAgentIcon } from './SupportAgentIcon';
import { FixPanel } from './FixPanel';
import { useSupportDiagnostics } from './useSupportDiagnostics';

type Tab = 'ask' | 'fix' | 'team';
const TABS: { id: Tab; label: string; Icon: typeof Wrench }[] = [
  { id: 'ask', label: 'Ask', Icon: Sparkles },
  { id: 'fix', label: 'Fix', Icon: Wrench },
  { id: 'team', label: 'Team', Icon: MessageCircle },
];

interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string; isError?: boolean; streaming?: boolean }

const STARTERS: { label: string; fix?: boolean }[] = [
  { label: "I can't sign in", fix: true },
  { label: "The page won't load", fix: true },
  { label: 'How much does Vireek cost?' },
  { label: 'Is my business data secure?' },
];

const HIDDEN_ROUTES = /^\/(dashboard|staff|wallboard)(\/|$)|^\/home(\/|$)/;

export function SupportAgent() {
  const { t } = useTranslation('common');
  const { pathname } = useLocation();
  const hidden = HIDDEN_ROUTES.test(pathname);
  const reduced = usePrefersReducedMotion();
  const d = useSupportDiagnostics(!hidden);

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('ask');
  const [status, setStatus] = useState(() => getSupportStatus());
  const [tooltip, setTooltip] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fallbackIncidentId] = useState(() => generateIncidentId());

  const launcherRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ ask: null, fix: null, team: null });
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const wasOpen = useRef(false);

  const openAgent = useCallback((next?: Tab) => {
    if (next) setTab(next);
    setOpen(true);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setStatus(getSupportStatus()), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Public hooks: other parts of the site can open the agent; opening live chat closes it (no stacked panels).
  useEffect(() => {
    const onOpen = (e: Event) => openAgent((e as CustomEvent<{ tab?: Tab }>).detail?.tab);
    const onLiveChat = () => setOpen(false);
    window.addEventListener('vireek:open-support-agent', onOpen);
    window.addEventListener('vireek:open-live-chat', onLiveChat);
    return () => {
      window.removeEventListener('vireek:open-support-agent', onOpen);
      window.removeEventListener('vireek:open-live-chat', onLiveChat);
    };
  }, [openAgent]);

  // Never overlap the Accessibility Center: close when it opens.
  useEffect(() => {
    const root = document.documentElement;
    const obs = new MutationObserver(() => {
      if (root.getAttribute('data-a11y-open') === 'true') setOpen(false);
    });
    obs.observe(root, { attributes: true, attributeFilter: ['data-a11y-open'] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open) {
      (tab === 'ask' ? inputRef.current : tabRefs.current[tab])?.focus();
    } else if (wasOpen.current) {
      launcherRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open, tab]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
  }, [messages, thinking, tab, reduced]);

  if (hidden) return null;

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || thinking) return;
    const history = messages.map((m) => ({ role: m.role, content: m.text }));
    setMessages((p) => [...p, { id: crypto.randomUUID(), role: 'user', text: q }]);
    setInput('');
    setThinking(true);
    const assistantId = crypto.randomUUID();
    let started = false;
    const controller = new AbortController();
    abortRef.current = controller;
    await streamAiChat({
      functionName: 'site-assistant',
      message: q,
      history,
      extraBody: d.aiSummary ? { diagnostics: d.aiSummary } : undefined,
      signal: controller.signal,
      onDelta: (delta) => {
        if (!started) {
          started = true;
          setThinking(false);
          setMessages((p) => [...p, { id: assistantId, role: 'assistant', text: delta, streaming: true }]);
        } else {
          setMessages((p) => p.map((m) => (m.id === assistantId ? { ...m, text: m.text + delta } : m)));
        }
      },
      onDone: () => {
        setThinking(false);
        setMessages((p) => p.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)));
      },
      onError: (message) => {
        setThinking(false);
        setMessages((p) => (started
          ? p.map((m) => (m.id === assistantId ? { ...m, text: message, isError: true, streaming: false } : m))
          : [...p, { id: assistantId, role: 'assistant', text: message, isError: true }]));
      },
    });
  };

  const starter = (s: (typeof STARTERS)[number]) => {
    if (s.fix) {
      setTab('fix');
      void d.runChecks();
    } else {
      void ask(s.label);
    }
  };

  const talkToTeam = () => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent('vireek:open-live-chat'));
  };

  const copyReport = async () => {
    if (!d.report) return;
    try {
      await navigator.clipboard.writeText(d.report);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked: the report is still visible via Email */ }
  };

  const onTabKey = (e: ReactKeyboardEvent, i: number) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = TABS[(i + dir + TABS.length) % TABS.length].id;
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  const incident = d.incidentId ?? fallbackIncidentId;
  const mailto = buildSupportMailto({
    incidentId: incident,
    url: typeof window === 'undefined' ? '' : window.location.pathname,
    time: new Date().toISOString(),
    message: d.report,
  });
  const dur = reduced ? 0 : 0.2;

  return (
    <>
      {/* Launcher rail: same right edge as the Accessibility Center, one slot above it. */}
      <div className={`fixed right-5 bottom-[calc(5rem_+_var(--vk-bottom-nav-h,0px))] z-overlay print:hidden [html[data-a11y-open=true]_&]:hidden ${open ? 'max-sm:hidden' : ''}`}>
        <AnimatePresence>
          {d.nudge && !open && (
            <motion.div
              initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: dur }}
              role="status"
              className="absolute bottom-full right-0 mb-2 flex w-64 items-start gap-1 rounded-surface border border-border bg-bg-secondary p-1 ps-3 shadow-elevation-3"
            >
              <button type="button" onClick={() => { openAgent('fix'); void d.runChecks(); }} className="focus-ring min-h-touch flex-1 py-1.5 text-start text-xs text-text-primary">
                {d.nudge}
              </button>
              <button type="button" aria-label="Dismiss suggestion" onClick={d.dismissNudge} className="focus-ring flex min-h-touch min-w-touch items-center justify-center rounded-control text-text-secondary hover:text-text-primary">
                <X size={14} aria-hidden="true" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        <motion.button
          ref={launcherRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          onMouseEnter={() => setTooltip(true)} onMouseLeave={() => setTooltip(false)}
          onFocus={() => setTooltip(true)} onBlur={() => setTooltip(false)}
          aria-label={open ? 'Close Vireek Support' : 'Open Vireek Support'}
          aria-expanded={open}
          aria-haspopup="dialog"
          whileHover={reduced ? undefined : { scale: 1.06 }} whileTap={reduced ? undefined : { scale: 0.94 }}
          className="focus-ring relative flex h-12 w-12 items-center justify-center rounded-control border border-white/30 bg-gradient-to-br from-accent to-cta text-white shadow-glow-accent"
        >
          {open ? <X size={20} aria-hidden="true" /> : <SupportAgentIcon size="md" state={d.iconState} />}
          {d.nudge && !open && (
            <span className="absolute -right-1 -top-1 flex h-3 w-3" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full rounded-full bg-cta opacity-75 motion-safe:animate-ping" />
              <span className="relative inline-flex h-3 w-3 rounded-full border-2 border-white bg-cta" />
            </span>
          )}
          <AnimatePresence>
            {tooltip && !open && !d.nudge && (
              <motion.span
                initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: dur }}
                className="pointer-events-none absolute right-14 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-control border border-border bg-bg-secondary px-3 py-1.5 text-xs font-medium text-text-primary shadow-elevation-2"
              >
                Vireek Support
              </motion.span>
            )}
          </AnimatePresence>
        </motion.button>
      </div>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: dur }}
              onClick={() => setOpen(false)} aria-hidden="true"
              className="fixed inset-0 z-overlay bg-slate-950/40 backdrop-blur-sm sm:hidden"
            />
            <motion.div
              initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 24 }} transition={{ duration: dur, ease: [0.16, 1, 0.3, 1] }}
              role="dialog" aria-modal="false" aria-label="Vireek Support"
              className="fixed inset-x-0 bottom-0 z-overlay flex h-[min(85dvh,44rem)] flex-col overflow-hidden rounded-t-overlay border border-border bg-bg-secondary pb-[env(safe-area-inset-bottom)] shadow-elevation-4 sm:inset-x-auto sm:right-5 sm:bottom-[calc(8.5rem_+_var(--vk-bottom-nav-h,0px))] sm:h-[min(36rem,calc(100dvh-11rem))] sm:w-96 sm:max-w-[calc(100vw-2.5rem)] sm:rounded-overlay sm:pb-0"
            >
              <header className="flex items-center gap-3 border-b border-border/80 px-4 py-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-inset bg-gradient-to-br from-accent to-cta text-white">
                  <SupportAgentIcon size="lg" state={d.iconState} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
                    Vireek Support <OnlineDot online={status.online} />
                  </p>
                  <p className="truncate text-xs text-text-secondary">
                    {status.online ? 'AI + our team, online now' : `AI available 24/7 · team back ${SUPPORT_HOURS_LABEL}`}
                  </p>
                </div>
                <Button variant="ghost" size="sm" iconOnly aria-label="Close Vireek Support" onClick={() => setOpen(false)}>
                  <X size={18} aria-hidden="true" />
                </Button>
              </header>

              <p className="border-b border-border/60 bg-bg-tertiary px-4 py-1.5 text-center text-xs font-medium text-text-secondary">
                {t('aiDisclosure.chatNotice')}
              </p>

              <div role="tablist" aria-label="Support options" className="grid grid-cols-3 gap-1 border-b border-border/80 p-1.5">
                {TABS.map(({ id, label, Icon }, i) => (
                  <button
                    key={id}
                    ref={(el) => { tabRefs.current[id] = el; }}
                    type="button" role="tab" id={`vk-agent-tab-${id}`} aria-controls={`vk-agent-panel-${id}`}
                    aria-selected={tab === id} tabIndex={tab === id ? 0 : -1}
                    onClick={() => setTab(id)} onKeyDown={(e) => onTabKey(e, i)}
                    className={`focus-ring flex min-h-touch items-center justify-center gap-1.5 rounded-control text-sm font-semibold ${tab === id ? 'bg-bg-tertiary text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
                  >
                    <Icon size={15} aria-hidden="true" /> {label}
                  </button>
                ))}
              </div>

              <div ref={scrollRef} role="tabpanel" id={`vk-agent-panel-${tab}`} aria-labelledby={`vk-agent-tab-${tab}`} className="flex-1 overflow-y-auto px-4 py-4">
                {tab === 'ask' && (
                  <div className="space-y-4">
                    {messages.length === 0 && (
                      <div className="space-y-2.5">
                        <div className="flex items-end gap-2.5">
                          <ChatAvatar role="assistant" />
                          <div className="max-w-[78%] rounded-surface rounded-bl-sm border border-border/70 bg-bg-tertiary px-4 py-2.5 text-sm leading-relaxed text-text-primary">
                            Hi! I can answer questions about Vireek, and fix sign-in or loading problems. What's going on?
                          </div>
                        </div>
                        <div className="space-y-2 ps-11">
                          {STARTERS.map((s) => <StarterPromptChip key={s.label} label={s.label} onClick={() => starter(s)} />)}
                        </div>
                      </div>
                    )}
                    {messages.map((m) => (
                      <MessageBubble key={m.id} role={m.role} isError={m.isError} streaming={m.streaming}>{m.text}</MessageBubble>
                    ))}
                    {thinking && <TypingIndicator />}
                  </div>
                )}

                {tab === 'fix' && <FixPanel d={d} onTalkToTeam={() => setTab('team')} />}

                {tab === 'team' && (
                  <div className="space-y-3">
                    <p className="text-sm text-text-secondary">
                      {status.online ? 'A real person is online now.' : `Our team is offline (${SUPPORT_HOURS_LABEL}). Leave a message and we reply by email.`}
                    </p>
                    <Button fullWidth size="sm" variant="primary" onClick={talkToTeam}>
                      <MessageCircle size={16} aria-hidden="true" /> {status.online ? 'Chat with our team' : 'Leave a message'}
                    </Button>
                    <a href={mailto} className="focus-ring inline-flex min-h-touch w-full items-center justify-center gap-2 rounded-control border border-border bg-bg-primary px-4 text-sm font-semibold text-text-primary hover:border-accent/40">
                      <Mail size={16} aria-hidden="true" /> Email support
                    </a>
                    <Button fullWidth size="sm" variant="secondary" disabled={!d.report} disabledReason="Run the quick check on the Fix tab first" onClick={() => void copyReport()}>
                      <Copy size={16} aria-hidden="true" /> {copied ? 'Copied' : 'Copy diagnostic report'}
                    </Button>
                    <p className="text-xs text-text-secondary">
                      Incident ID: <span className="font-mono text-text-primary">{incident}</span>. The report has no email, password or token.
                    </p>
                  </div>
                )}
              </div>

              {tab === 'ask' && (
                <form onSubmit={(e) => { e.preventDefault(); void ask(input); }} className="flex items-center gap-2 border-t border-border/80 p-3">
                  <input
                    ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} maxLength={500}
                    aria-label="Ask Vireek Support" placeholder="Ask anything about Vireek…"
                    className="focus-ring min-h-touch flex-1 rounded-control border border-border bg-bg-primary px-3.5 text-sm text-text-primary"
                  />
                  <Button type="submit" iconOnly size="md" variant="primary" aria-label="Send" disabled={!input.trim() || thinking}>
                    <Send size={16} aria-hidden="true" />
                  </Button>
                </form>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
