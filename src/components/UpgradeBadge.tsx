import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Sparkles, X } from 'lucide-react';

const STORAGE_KEY = 'vireek-upgrade-badge-dismissed';
const SHOW_AFTER_MS = 1500;

export function UpgradeBadge() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const dismissed = localStorage.getItem(STORAGE_KEY);
    if (dismissed) return;

    const timer = setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  const dismiss = () => {
    localStorage.setItem(STORAGE_KEY, '1');
    setVisible(false);
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ y: 40, opacity: 0, scale: 0.95 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          exit={{ y: 20, opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className="fixed bottom-5 right-5 z-[70] sm:bottom-6 sm:right-6"
        >
          <div className="group relative flex items-center gap-3 rounded-2xl border border-border bg-bg-secondary/95 py-3 pl-4 pr-3 shadow-card backdrop-blur-md dark:shadow-card-dark hover:shadow-glow-accent transition-shadow duration-200">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
              <Sparkles size={16} />
            </span>

            <Link to="/pricing" onClick={dismiss} className="focus-ring rounded-md">
              <p className="text-sm font-semibold leading-tight text-text-primary">
                Upgrade your plan
              </p>
              <p className="text-xs leading-tight text-text-secondary">
                Unlock more features &rarr;
              </p>
            </Link>

            <button
              type="button"
              onClick={dismiss}
              aria-label="Dismiss"
              className="focus-ring ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-secondary/70 transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            >
              <X size={13} />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
