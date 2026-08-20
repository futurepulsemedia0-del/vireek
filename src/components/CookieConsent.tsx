import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';

const STORAGE_KEY = 'vireek-cookie-consent';

function disableNonEssentialTracking() {
  // Placeholder for future analytics opt-out logic
}

export function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) setVisible(true);
  }, []);

  const dismiss = (choice: 'accepted' | 'declined') => {
    localStorage.setItem(STORAGE_KEY, choice);
    if (choice === 'declined') disableNonEssentialTracking();
    setVisible(false);
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className="fixed inset-x-0 bottom-0 z-[60] px-4 pb-4 sm:px-6 sm:pb-6"
        >
          <div className="mx-auto flex max-w-5xl flex-col items-center gap-4 rounded-2xl border border-border bg-bg-secondary/90 p-5 shadow-card backdrop-blur-md dark:shadow-card-dark sm:flex-row sm:gap-6 sm:p-6">
            <p className="flex-1 text-center text-sm leading-relaxed text-text-secondary sm:text-left">
              We use cookies to improve your experience and analyze site traffic. By continuing, you
              agree to our use of cookies.{' '}
              <Link to="/privacy" className="font-semibold text-accent hover:underline">
                Privacy Policy
              </Link>
            </p>
            <div className="flex shrink-0 items-center gap-3">
              <Button variant="ghost" size="sm" onClick={() => dismiss('declined')}>
                Decline
              </Button>
              <Button variant="primary" size="sm" onClick={() => dismiss('accepted')}>
                Accept
              </Button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
