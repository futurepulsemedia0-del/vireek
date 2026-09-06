import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import {
  ShieldCheck,
  Lock,
  BarChart3,
  Sparkles,
  Megaphone,
  BrainCircuit,
  Check,
  X,
  ArrowRight,
  ChevronRight,
} from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Consent engine                                                     */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = 'vireek-consent-v2';
const CONSENT_VERSION = 2;

type ConsentCategory = 'essential' | 'analytics' | 'personalization' | 'marketing' | 'ai';
type ConsentState = Record<ConsentCategory, boolean> & { version: number; timestamp: string };

const DEFAULT_STATE: Omit<ConsentState, 'version' | 'timestamp'> = {
  essential: true,
  analytics: false,
  personalization: false,
  marketing: false,
  ai: false,
};

function readConsent(): ConsentState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ConsentState;
    if (parsed.version !== CONSENT_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeConsent(state: Omit<ConsentState, 'version' | 'timestamp'>) {
  const full: ConsentState = {
    ...state,
    version: CONSENT_VERSION,
    timestamp: new Date().toISOString(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(full));
}

function applyConsent(state: Omit<ConsentState, 'version' | 'timestamp'>) {
  // Gate non-essential tracking here when analytics are wired in.
  // For now this is a no-op stub that respects the user's choices.
  if (!state.analytics) { /* disable analytics */ }
  if (!state.marketing) { /* disable marketing pixels */ }
}

/* ------------------------------------------------------------------ */
/*  iOS-quality toggle switch                                          */
/* ------------------------------------------------------------------ */

type ToggleProps = {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  label: string;
  id: string;
};

function Toggle({ checked, disabled, onChange, label, id }: ToggleProps) {
  const handleKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      onChange(!checked);
    }
  };

  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onClick={() => !disabled && onChange(!checked)}
      onKeyDown={handleKey}
      className={`focus-ring relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors duration-200 ease-out ${
        disabled
          ? 'cursor-not-allowed bg-accent/30'
          : checked
            ? 'bg-accent'
            : 'bg-border hover:bg-border/70'
      }`}
    >
      <motion.span
        layout
        transition={{ type: 'spring', stiffness: 500, damping: 32 }}
        className={`pointer-events-none block h-5 w-5 rounded-full bg-white shadow-sm ${
          checked ? 'ml-auto mr-1' : 'ml-1'
        }`}
      />
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Privacy category card                                              */
/* ------------------------------------------------------------------ */

type CategoryDef = {
  key: ConsentCategory;
  icon: typeof Lock;
  title: string;
  description: string;
  alwaysActive?: boolean;
};

const CATEGORIES: CategoryDef[] = [
  {
    key: 'essential',
    icon: Lock,
    title: 'Essential Cookies',
    description: 'Required for security, authentication, account access, and core functionality.',
    alwaysActive: true,
  },
  {
    key: 'analytics',
    icon: BarChart3,
    title: 'Analytics Intelligence',
    description: 'Helps us understand usage patterns and improve Vireek performance.',
  },
  {
    key: 'personalization',
    icon: Sparkles,
    title: 'Experience Personalization',
    description: 'Allows personalized experiences and improved recommendations.',
  },
  {
    key: 'marketing',
    icon: Megaphone,
    title: 'Marketing Optimization',
    description: 'Helps measure campaigns and provide relevant communication.',
  },
  {
    key: 'ai',
    icon: BrainCircuit,
    title: 'AI Improvement Data',
    description: 'Helps improve AI experiences while respecting privacy preferences.',
  },
];

function CategoryCard({
  def,
  checked,
  onChange,
}: {
  def: CategoryDef;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const Icon = def.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="group rounded-2xl border border-border bg-bg-secondary p-5 transition-colors duration-200 hover:border-accent/25"
    >
      <div className="flex items-start gap-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
          <Icon size={20} />
        </span>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold text-text-primary">{def.title}</h4>
            {def.alwaysActive && (
              <span className="inline-flex items-center gap-1 rounded-full bg-success-500/15 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-success-500">
                <Lock size={10} />
                Always Active
              </span>
            )}
          </div>
          <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">{def.description}</p>
        </div>
        <div className="shrink-0 pt-0.5">
          <Toggle
            id={`toggle-${def.key}`}
            checked={def.alwaysActive ? true : checked}
            disabled={def.alwaysActive}
            onChange={onChange}
            label={def.title}
          />
        </div>
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Privacy Center modal                                               */
/* ------------------------------------------------------------------ */

function PrivacyCenter({
  initial,
  onSave,
  onClose,
}: {
  initial: Omit<ConsentState, 'version' | 'timestamp'>;
  onSave: (s: Omit<ConsentState, 'version' | 'timestamp'>) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState(initial);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Focus trap
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = panel.querySelectorAll<HTMLElement>(
      'button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    closeBtnRef.current?.focus();

    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    panel.addEventListener('keydown', trap);
    return () => panel.removeEventListener('keydown', trap);
  }, []);

  // Escape to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const update = (key: ConsentCategory, value: boolean) =>
    setState((prev) => ({ ...prev, [key]: value }));

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-950/50 backdrop-blur-md sm:items-center sm:p-6"
      onClick={onClose}
    >
      <motion.div
        ref={panelRef}
        initial={{ y: 40, opacity: 0, scale: 0.98 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: 30, opacity: 0, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 320, damping: 30 }}
        onClick={(e) => e.stopPropagation()}
        className="relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-3xl border border-border bg-bg-secondary shadow-2xl sm:max-w-lg sm:rounded-3xl"
      >
        {/* Header */}
        <div className="relative shrink-0 border-b border-border bg-bg-tertiary px-6 py-5 sm:px-8">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                'radial-gradient(circle at 80% 30%, rgb(var(--accent-primary) / 0.08), transparent 60%)',
            }}
          />
          <div className="relative flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <ShieldCheck size={20} className="text-accent" />
                <h3 className="text-lg font-bold tracking-tight text-text-primary">Privacy Center</h3>
              </div>
              <p className="mt-1 text-sm text-text-secondary">
                Manage exactly how Vireek uses your data.
              </p>
            </div>
            <button
              ref={closeBtnRef}
              type="button"
              onClick={onClose}
              aria-label="Close privacy center"
              className="focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Scrollable category list */}
        <div className="flex-1 space-y-3 overflow-y-auto px-6 py-6 sm:px-8">
          {CATEGORIES.map((def) => (
            <CategoryCard
              key={def.key}
              def={def}
              checked={state[def.key]}
              onChange={(v) => update(def.key, v)}
            />
          ))}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-border bg-bg-tertiary px-6 py-5 sm:px-8">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4 text-xs text-text-secondary">
              <Link to="/privacy" className="focus-ring rounded font-medium text-accent hover:underline">
                Privacy Policy
              </Link>
              <Link to="/terms" className="focus-ring rounded font-medium text-accent hover:underline">
                Cookie Policy
              </Link>
            </div>
            <button
              type="button"
              onClick={() => onSave(state)}
              className="focus-ring inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-6 py-3 text-sm font-semibold text-white shadow-sm transition-all duration-150 ease-out hover:brightness-110 hover:shadow-glow-accent active:brightness-90"
            >
              <Check size={16} />
              Save Preferences
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function CookieConsent() {
  const [bannerVisible, setBannerVisible] = useState(false);
  const [centerOpen, setCenterOpen] = useState(false);
  const [preferences, setPreferences] = useState(DEFAULT_STATE);
  const [reopened, setReopened] = useState(false);

  // Check existing consent on mount
  useEffect(() => {
  const existing = readConsent();
  if (!existing) {
    const timer = setTimeout(() => {
      setBannerVisible(true);
    }, 1500); // اینجا میلی‌ثانیه رو تنظیم کن، 1500 = 1.5 ثانیه
    return () => clearTimeout(timer);
  } else {
    applyConsent(existing);
  }
}, []);

  const acceptAll = useCallback(() => {
    const all = { ...DEFAULT_STATE, analytics: true, personalization: true, marketing: true, ai: true };
    writeConsent(all);
    applyConsent(all);
    setPreferences(all);
    setBannerVisible(false);
  }, []);

  const rejectNonEssential = useCallback(() => {
    const rejected = { ...DEFAULT_STATE };
    writeConsent(rejected);
    applyConsent(rejected);
    setPreferences(rejected);
    setBannerVisible(false);
  }, []);

  const savePreferences = useCallback(
    (s: Omit<ConsentState, 'version' | 'timestamp'>) => {
      writeConsent(s);
      applyConsent(s);
      setPreferences(s);
      setCenterOpen(false);
      setBannerVisible(false);
      setReopened(false);
    },
    []
  );

  // Allow reopening from footer via custom event
  useEffect(() => {
    const handler = () => {
      const existing = readConsent();
      setPreferences(existing ? { ...existing } : DEFAULT_STATE);
      setReopened(true);
      setCenterOpen(true);
    };
    window.addEventListener('vireek:open-consent', handler);
    return () => window.removeEventListener('vireek:open-consent', handler);
  }, []);

  const openCenter = () => {
    setPreferences((prev) => {
      const existing = readConsent();
      return existing ? { ...existing } : prev;
    });
    setCenterOpen(true);
  };

  return (
    <>
      {/* Floating banner */}
      <AnimatePresence>
        {bannerVisible && !centerOpen && (
          <motion.div
            initial={{ y: 120, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 120, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 280, damping: 28, mass: 0.6 }}
            className="fixed inset-x-0 bottom-0 z-[70] px-4 pb-4 sm:px-6 sm:pb-6"
          >
            <div className="mx-auto w-full max-w-2xl overflow-hidden rounded-2xl border border-border bg-bg-secondary/90 shadow-2xl backdrop-blur-xl">
              {/* Decorative top accent line */}
              <div className="h-px bg-gradient-to-r from-transparent via-accent/50 to-transparent" />

              <div className="p-5 sm:p-6">
                {/* Header row */}
                <div className="flex items-center gap-3">
                  <motion.span
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ delay: 0.15, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                    className="flex h-10 w-10 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent"
                  >
                    <ShieldCheck size={20} />
                  </motion.span>
                  <div>
                    <h3 className="text-base font-bold tracking-tight text-text-primary">
                      Your Privacy, Your Control
                    </h3>
                    <p className="text-xs font-medium text-text-secondary/70">
                      Vireek takes a privacy-first approach to every interaction.
                    </p>
                  </div>
                </div>

                {/* Description */}
                <p className="mt-4 text-sm leading-relaxed text-text-secondary">
                  We use privacy-friendly technologies to improve your experience, understand
                  platform performance, and personalize your journey. You are always in control.
                </p>

                {/* Buttons */}
                <div className="mt-5 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-3">
                  <button
                    type="button"
                    onClick={acceptAll}
                    className="focus-ring group inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-white shadow-sm transition-all duration-150 ease-out hover:brightness-110 hover:shadow-glow-accent active:brightness-90"
                  >
                    Accept All
                    <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />
                  </button>
                  <button
                    type="button"
                    onClick={rejectNonEssential}
                    className="focus-ring inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-bg-tertiary px-5 py-3 text-sm font-semibold text-text-primary transition-all duration-150 hover:border-accent/30 hover:bg-bg-tertiary/80 active:brightness-95 sm:flex-none"
                  >
                    Reject Non-Essential
                  </button>
                  <button
                    type="button"
                    onClick={openCenter}
                    className="focus-ring inline-flex items-center justify-center gap-1 rounded-xl px-4 py-3 text-sm font-semibold text-text-secondary transition-colors hover:text-accent sm:flex-none"
                  >
                    Customize
                    <ChevronRight size={15} />
                  </button>
                </div>

                {/* Policy links */}
                <div className="mt-4 flex items-center gap-4 border-t border-border/60 pt-3 text-xs">
                  <Link to="/privacy" className="focus-ring rounded font-medium text-accent hover:underline">
                    Privacy Policy
                  </Link>
                  <Link to="/terms" className="focus-ring rounded font-medium text-accent hover:underline">
                    Cookie Policy
                  </Link>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Privacy Center modal */}
      <AnimatePresence>
        {centerOpen && (
          <PrivacyCenter
            initial={preferences}
            onSave={savePreferences}
            onClose={() => {
              setCenterOpen(false);
              if (reopened) setReopened(false);
            }}
          />
        )}
      </AnimatePresence>
    </>
  );
}
