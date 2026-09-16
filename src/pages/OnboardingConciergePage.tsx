import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Loader as Loader2, Send, Sparkles, Phone, CheckCircle2, Circle, ArrowRight } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase, BusinessProfile } from '@/lib/supabase';
import { ThemeToggle } from '@/components/ThemeToggle';
import { streamAiChat } from '@/lib/aiStream';
import {
  ConciergeMessage,
  OnboardingFields,
  CONCIERGE_WELCOME,
  checklistProgress,
  isReadyToFinish,
  knownFromProfile,
  toProfilePayload,
  toBusinessProfilePayload,
} from '@/lib/onboardingConcierge';

export function OnboardingConciergePage() {
  const navigate = useNavigate();
  const { user, profile, profileLoading, refreshProfile } = useAuth();
  const { toast } = useToast();

  const [initializing, setInitializing] = useState(true);
  const [messages, setMessages] = useState<ConciergeMessage[]>([{ role: 'assistant', content: CONCIERGE_WELCOME }]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [known, setKnown] = useState<OnboardingFields>({});
  const streamingTextRef = useRef('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!profileLoading && profile?.onboarding_completed) {
      navigate('/dashboard', { replace: true });
    }
  }, [profile, profileLoading, navigate]);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase.from('business_profile').select('*').eq('user_id', user.id).maybeSingle();
      setKnown(knownFromProfile(profile, (data as BusinessProfile) ?? null));
      setInitializing(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const persistFields = useCallback(
    async (fields: OnboardingFields) => {
      if (!user) return;
      const profilePayload = toProfilePayload(fields);
      const businessPayload = toBusinessProfilePayload(fields);
      if (Object.keys(profilePayload).length > 0) {
        await supabase.from('profiles').update(profilePayload).eq('id', user.id);
      }
      if (Object.keys(businessPayload).length > 0) {
        await supabase.from('business_profile').upsert({ user_id: user.id, ...businessPayload }, { onConflict: 'user_id' });
      }
    },
    [user],
  );

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending || !user) return;
    setInput('');
    setSending(true);

    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '' }]);
    streamingTextRef.current = '';

    await streamAiChat({
      functionName: 'onboarding-concierge',
      message: text,
      history,
      extraBody: { known },
      onFields: (fields) => {
        const sanitized = fields as OnboardingFields;
        if (Object.keys(sanitized).length === 0) return;
        setKnown((prev) => ({ ...prev, ...sanitized }));
        persistFields(sanitized);
      },
      onDelta: (delta) => {
        streamingTextRef.current += delta;
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = { role: 'assistant', content: streamingTextRef.current };
          return next;
        });
      },
      onDone: () => setSending(false),
      onError: (msg) => {
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = { role: 'assistant', content: msg };
          return next;
        });
        setSending(false);
      },
    });
  };

  const handleFinish = async () => {
    if (!user) return;
    setFinishing(true);
    try {
      const { data: updatedProfile, error } = await supabase
        .from('profiles')
        .update({ onboarding_completed: true })
        .eq('id', user.id)
        .select('onboarding_completed')
        .maybeSingle();
      if (error) throw error;
      if (!updatedProfile?.onboarding_completed) {
        toast('Could not save your setup — please sign out and back in, then try again.', 'error');
        return;
      }
      await refreshProfile();
      toast('Welcome to Vireek! Your dashboard is ready.', 'success');
      navigate('/dashboard', { replace: true });
    } catch {
      toast('Could not finish setup. Please try again.', 'error');
    } finally {
      setFinishing(false);
    }
  };

  const progress = checklistProgress(known);
  const ready = isReadyToFinish(known);

  if (profileLoading || initializing) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary">
        <Loader2 size={24} className="animate-spin text-accent" />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-noise bg-gradient-mesh px-4 py-6 sm:px-6">
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-bg-primary via-bg-primary to-bg-secondary" />

      <div className="mb-6 flex items-center justify-between">
        <span className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-white">
            <Phone size={16} strokeWidth={2.5} />
          </span>
          <span className="text-lg font-bold tracking-tight text-accent">Vireek</span>
        </span>
        <div className="flex items-center gap-3">
          <Link to="/onboarding/classic" className="focus-ring hidden text-xs font-medium text-text-secondary hover:text-accent sm:block">
            Prefer the step-by-step form?
          </Link>
          <ThemeToggle />
        </div>
      </div>

      <div className="mx-auto grid w-full max-w-5xl flex-1 gap-4 lg:grid-cols-[1fr_280px]">
        {/* Chat panel */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="flex min-h-[520px] flex-col rounded-2xl border border-border bg-bg-secondary/90 shadow-card backdrop-blur-md dark:shadow-card-dark"
        >
          <div className="flex items-center gap-2 border-b border-border px-5 py-4">
            <Sparkles size={16} className="text-accent" />
            <p className="text-sm font-semibold text-text-primary">Onboarding Concierge</p>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    m.role === 'user'
                      ? 'bg-accent text-white'
                      : 'border border-border bg-bg-primary text-text-primary'
                  }`}
                >
                  {m.content || (sending && i === messages.length - 1 ? '…' : '')}
                </div>
              </div>
            ))}
          </div>

          <div className="border-t border-border p-4">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="Tell me about your business…"
                rows={1}
                disabled={sending}
                className="focus-ring flex-1 resize-none rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 disabled:opacity-60"
              />
              <button
                type="button"
                onClick={handleSend}
                disabled={sending || !input.trim()}
                className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-white transition-all hover:brightness-110 disabled:opacity-50"
                aria-label="Send"
              >
                {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              </button>
            </div>
          </div>
        </motion.div>

        {/* Checklist panel */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
          className="flex h-fit flex-col gap-4 rounded-2xl border border-border bg-bg-secondary/90 p-5 shadow-card backdrop-blur-md dark:shadow-card-dark"
        >
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-sm font-semibold text-text-primary">Setup progress</p>
              <span className="text-xs text-text-secondary">
                {progress.done}/{progress.total}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{ width: `${(progress.done / progress.total) * 100}%` }}
              />
            </div>
          </div>

          <ul className="space-y-2">
            {progress.items.map((item) => (
              <li key={item.key} className="flex items-center gap-2 text-sm">
                {item.done ? (
                  <CheckCircle2 size={16} className="shrink-0 text-success-500" />
                ) : (
                  <Circle size={16} className="shrink-0 text-text-secondary/40" />
                )}
                <span className={item.done ? 'text-text-primary' : 'text-text-secondary'}>{item.label}</span>
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={handleFinish}
            disabled={finishing || !ready}
            className="focus-ring flex items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50"
          >
            {finishing ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
            Finish setup
          </button>
          {!ready && (
            <p className="text-center text-xs text-text-secondary">
              A few more essentials to go before you can finish.
            </p>
          )}
        </motion.div>
      </div>
    </div>
  );
}
