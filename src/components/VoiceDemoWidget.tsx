import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, ArrowRight, Loader2, Mic, MicOff, PhoneOff, Radio } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EASE } from '@/lib/motion';
import { getVapiClient, VAPI_DEMO_ASSISTANT_ID } from '@/lib/vapi';

type CallState = 'idle' | 'connecting' | 'active' | 'ended' | 'error';

interface TranscriptLine {
  role: 'assistant' | 'user';
  text: string;
}

// Raised from 6 → 50 now that the transcript panel actually scrolls inside
// its own box instead of growing the whole card (see min-h-0 fix below).
const MAX_TRANSCRIPT_LINES = 50;
const GENERIC_ERROR =
  "Couldn't start the voice demo — check that your microphone is allowed for this site, then try again.";

function formatDuration(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Live mic-reactive waveform, driven by Vapi's `volume-level` event (0–1). */
function LiveWaveform({ level }: { level: number }) {
  const bars = [0.5, 0.8, 1, 0.65, 0.4, 0.7, 0.5];
  return (
    <div className="flex items-end gap-[3px]" aria-hidden="true">
      {bars.map((base, i) => (
        <motion.span
          key={i}
          className="w-[3px] rounded-full bg-white/90"
          animate={{ height: `${Math.max(6, base * 24 * (0.4 + level * 1.6))}px` }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
        />
      ))}
    </div>
  );
}

/**
 * "Talk to Sarah — live voice, in the browser." Uses the Vapi Web SDK to
 * place a real call to the dedicated Vireek DEMO assistant (see
 * src/lib/vapi.ts) — never the production dispatch assistant, and never
 * with the lookup_customer / book_appointment tools attached.
 */
export function VoiceDemoWidget() {
  const [state, setState] = useState<CallState>('idle');
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0);
  const [duration, setDuration] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const timerRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [transcript]);

  // Always stop any live call when the widget unmounts (e.g. route change).
  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      try {
        getVapiClient().stop();
      } catch {
        // Client was never initialized (e.g. key missing) — nothing to stop.
      }
    };
  }, []);

  const startCall = useCallback(async () => {
    setErrorMessage(null);
    setTranscript([]);
    setDuration(0);
    setState('connecting');

    let vapi;
    try {
      vapi = getVapiClient();
    } catch (err) {
      setState('error');
      setErrorMessage(err instanceof Error ? err.message : GENERIC_ERROR);
      return;
    }

    // Fresh listeners each call, so a second call doesn't double-fire old ones.
    vapi.removeAllListeners();

    vapi.on('call-start', () => {
      setState('active');
      timerRef.current = window.setInterval(() => setDuration((d) => d + 1), 1000);
    });

    vapi.on('call-end', () => {
      setState('ended');
      if (timerRef.current) window.clearInterval(timerRef.current);
    });

    vapi.on('volume-level', (level) => setVolume(level));

    vapi.on('message', (message) => {
      if (message.type === 'transcript' && message.transcriptType === 'final') {
        setTranscript((prev) =>
          [...prev, { role: message.role, text: message.transcript }].slice(-MAX_TRANSCRIPT_LINES)
        );
      }
    });

    vapi.on('error', (err) => {
      console.error('Vapi error:', err);
      setState('error');
      setErrorMessage(GENERIC_ERROR);
      if (timerRef.current) window.clearInterval(timerRef.current);
    });

    try {
      await vapi.start(VAPI_DEMO_ASSISTANT_ID);
    } catch (err) {
      console.error(err);
      setState('error');
      setErrorMessage(GENERIC_ERROR);
    }
  }, []);

  const endCall = useCallback(() => {
    try {
      getVapiClient().stop();
    } catch {
      // no-op
    }
    setState('ended');
    if (timerRef.current) window.clearInterval(timerRef.current);
  }, []);

  const toggleMute = useCallback(() => {
    try {
      const vapi = getVapiClient();
      vapi.setMuted(!muted);
      setMuted((m) => !m);
    } catch {
      // no-op
    }
  }, [muted]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.5, ease: EASE }}
      className="relative flex h-[440px] flex-col overflow-hidden rounded-2xl border border-accent/30 bg-bg-secondary shadow-card dark:shadow-card-dark sm:h-[520px]"
    >
      {/* Featured ribbon — this is the flagship demo experience */}
      <div className="absolute right-4 top-4 z-10 rounded-full bg-accent px-2.5 py-1 text-[0.6875rem] font-bold uppercase tracking-wide text-white">
        Live voice
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-tertiary/60 px-4 py-3.5 sm:px-5 sm:py-4">
        <Radio size={15} className="text-accent sm:size-4" />
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-text-secondary sm:text-sm sm:tracking-[0.18em]">
          Talk to Sarah — real voice, right now
        </p>
      </div>

      {/*
        min-h-0 is required here: without it, a flex child with flex-1 will
        never shrink below its content's natural height (flexbox default is
        min-height: auto). That was the original bug — once the transcript
        got long, this panel grew past the card's fixed height instead of
        scrolling, and pushed the mute/hang-up buttons out of view.
      */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-6 py-6 text-center">
        <AnimatePresence mode="wait">
          {state === 'idle' && (
            <motion.div
              key="idle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-4"
            >
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-accent/10 text-accent">
                <Mic size={26} />
              </span>
              <p className="max-w-[260px] text-sm text-text-secondary">
                No phone call, no form — click below, allow your mic, and talk to the real AI
                live in your browser.
              </p>
              <button
                type="button"
                onClick={startCall}
                className="focus-ring inline-flex items-center gap-2 rounded-xl bg-accent px-6 py-3.5 text-base font-semibold text-white shadow-sm transition-all hover:brightness-110 hover:shadow-glow-accent active:scale-[0.97]"
              >
                <Mic size={18} />
                Talk to Sarah live
              </button>
              <p className="text-[0.6875rem] text-text-secondary/70">
                This call is live and answered by AI, not a recording.
              </p>
            </motion.div>
          )}

          {state === 'connecting' && (
            <motion.div
              key="connecting"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-3"
            >
              <Loader2 size={28} className="animate-spin text-accent" />
              <p className="text-sm text-text-secondary">Connecting you to Sarah…</p>
            </motion.div>
          )}

          {state === 'active' && (
            <motion.div
              key="active"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex min-h-0 w-full flex-1 flex-col items-center gap-4"
            >
              {/* Header row (waveform + timer) — fixed size, never shrinks */}
              <div className="flex shrink-0 items-center gap-3">
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent">
                  <LiveWaveform level={volume} />
                </span>
                <div className="text-left">
                  <p className="text-sm font-semibold text-text-primary">Sarah is live</p>
                  <p className="text-xs text-text-secondary">{formatDuration(duration)}</p>
                </div>
              </div>

              {/* Transcript — the only part that scrolls. min-h-0 + overflow-y-auto
                  keep it capped inside the available space no matter how long
                  the conversation gets, so the buttons below stay put. */}
              <div
                ref={scrollRef}
                aria-live="polite"
                className="w-full min-h-0 flex-1 space-y-2 overflow-y-auto rounded-xl border border-border bg-bg-primary px-3 py-3 text-left [scrollbar-width:thin]"
              >
                {transcript.length === 0 ? (
                  <p className="text-center text-xs text-text-secondary/70">
                    Listening… say hello, or try a real scenario.
                  </p>
                ) : (
                  transcript.map((line, i) => (
                    <div
                      key={i}
                      className={`flex ${line.role === 'assistant' ? 'justify-start' : 'justify-end'}`}
                    >
                      <div
                        className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-xs leading-relaxed break-words ${
                          line.role === 'assistant'
                            ? 'bg-accent/10 text-text-primary'
                            : 'bg-bg-tertiary text-text-primary'
                        }`}
                      >
                        <span
                          className={`mb-0.5 block text-[0.6875rem] font-semibold ${
                            line.role === 'assistant' ? 'text-accent' : 'text-text-secondary'
                          }`}
                        >
                          {line.role === 'assistant' ? 'Sarah' : 'You'}
                        </span>
                        {line.text}
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Controls — fixed size, always visible regardless of transcript length */}
              <div className="flex shrink-0 items-center gap-3">
                <button
                  type="button"
                  onClick={toggleMute}
                  aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
                  className="focus-ring flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-primary transition-colors hover:border-accent/40"
                >
                  {muted ? <MicOff size={18} /> : <Mic size={18} />}
                </button>
                <button
                  type="button"
                  onClick={endCall}
                  aria-label="End call"
                  className="focus-ring flex h-11 w-11 items-center justify-center rounded-xl bg-danger text-white transition-opacity hover:brightness-110"
                >
                  <PhoneOff size={18} />
                </button>
              </div>
            </motion.div>
          )}

          {state === 'ended' && (
            <motion.div
              key="ended"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-4"
            >
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-success/10 text-success">
                <Mic size={22} />
              </span>
              <p className="max-w-[260px] text-sm text-text-secondary">
                That's Sarah — live, on every call, every time. Like what you heard?
              </p>
              <div className="flex flex-col items-center gap-2 sm:flex-row">
                <Link
                  to="/signup"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white shadow-glow-accent hover:brightness-110"
                >
                  Start free trial
                  <ArrowRight size={15} />
                </Link>
                <button
                  type="button"
                  onClick={startCall}
                  className="focus-ring rounded-xl border border-border px-5 py-2.5 text-sm font-semibold text-text-secondary hover:border-accent/40 hover:text-text-primary"
                >
                  Talk to her again
                </button>
              </div>
            </motion.div>
          )}

          {state === 'error' && (
            <motion.div
              key="error"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-3"
            >
              <AlertCircle size={24} className="text-danger" />
              <p className="max-w-[260px] text-sm text-text-secondary">{errorMessage}</p>
              <button
                type="button"
                onClick={startCall}
                className="focus-ring rounded-xl border border-border px-5 py-2.5 text-sm font-semibold text-text-secondary hover:border-accent/40 hover:text-text-primary"
              >
                Try again
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
