import { FormEvent, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X, Mail, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EASE } from '@/lib/motion';

const SESSION_KEY = 'vireek-exit-intent-shown';

/**
 * Fires once per browser session when the cursor leaves through the top of
 * the viewport (the classic "about to close the tab / hit the back button"
 * signal) — but only on desktop pointer devices, and never if the visitor
 * has already scrolled past the point of just bouncing immediately, or if
 * they've already interacted with a form on the page.
 */
export function ExitIntentCapture() {
  const [visible, setVisible] = useState(false);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const hasArmedRef = useRef(false);

  useEffect(() => {
    // Only for pointer (mouse) devices — exit-intent via mouse position
    // doesn't make sense on touch, and firing it there would just annoy
    // mobile visitors.
    if (window.matchMedia('(pointer: coarse)').matches) return;

    try {
      if (sessionStorage.getItem(SESSION_KEY) === '1') return;
    } catch {
      // sessionStorage unavailable — fall through and allow it to show,
      // worst case it can show more than once for this visitor.
    }

    // Give the page a couple seconds before arming, so an immediate mouse
    // movement toward the address bar right on load doesn't trigger it.
    const armTimer = window.setTimeout(() => {
      hasArmedRef.current = true;
    }, 4000);

    const handleMouseLeave = (e: MouseEvent) => {
      if (!hasArmedRef.current) return;
      if (e.clientY > 0) return; // only the top edge counts
      setVisible(true);
      try {
        sessionStorage.setItem(SESSION_KEY, '1');
      } catch {
        // Non-fatal — see above.
      }
      document.removeEventListener('mouseleave', handleMouseLeave);
    };

    document.addEventListener('mouseleave', handleMouseLeave);
    return () => {
      window.clearTimeout(armTimer);
      document.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, []);

  const close = () => setVisible(false);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
    setLoading(true);
    try {
      // Reuses the same lead-capture endpoint as the rest of the site.
      const response = await fetch('https://submit-form.com/USdWD1urW', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, requestType: 'exit_intent_capture' }),
      });
      if (response.ok) setSubmitted(true);
    } catch {
      // Fail silently — this is a low-stakes secondary capture, not a
      // critical flow. No need to surface an error UI for it.
    } finally {
      setLoading(false);
    }
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Before you go"
          onClick={close}
        >
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.97 }}
            transition={{ duration: 0.35, ease: EASE }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-md overflow-hidden rounded-2xl border border-border bg-bg-secondary p-7 shadow-card-hover dark:shadow-card-hover-dark sm:p-8"
          >
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="focus-ring absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary/70 transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            >
              <X size={16} />
            </button>

            {submitted ? (
              <div className="flex flex-col items-center py-6 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-success-500/10 text-success-500">
                  <CheckCircle2 size={22} />
                </span>
                <h2 className="mt-4 text-lg font-bold text-text-primary">You&apos;re on the list</h2>
                <p className="mt-1.5 text-sm text-text-secondary">
                  We&apos;ll send it straight to your inbox.
                </p>
              </div>
            ) : (
              <>
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  <Mail size={20} />
                </span>
                <h2 className="mt-4 text-xl font-bold text-text-primary">Before you go \u2014</h2>
                <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                  Get a free guide on how much missed calls are actually costing your business,
                  plus a heads-up when we run limited-time offers.
                </p>
                <form onSubmit={handleSubmit} className="mt-5 flex flex-col gap-3 sm:flex-row">
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    aria-label="Email address"
                    className="focus-ring w-full flex-1 rounded-xl border border-border bg-bg-primary px-4 py-3 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors focus-visible:border-accent"
                  />
                  <Button type="submit" variant="primary" disabled={loading} className="shrink-0">
                    {loading ? 'Sending…' : 'Send it to me'}
                  </Button>
                </form>
                <button
                  type="button"
                  onClick={close}
                  className="focus-ring mt-3 text-xs text-text-secondary/70 transition-colors hover:text-text-secondary"
                >
                  No thanks, just leaving
                </button>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
